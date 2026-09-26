# TrackIT OJT Dashboard - Authentication & MongoDB Setup Complete

## What's Been Configured

### 1. **Authentication System** ✅
- **JWT-based authentication** with 7-day expiration
- **Login/Register endpoints** for all user roles (student, coordinator, supervisor)
- **Auth middleware** for protected routes in `backend/middleware/auth.js`
- **Token storage** in localStorage (`trackit_token`, `trackit_user`)
- **Automatic redirect** to login for unauthenticated access to dashboard

### 2. **Student Dashboard** ✅
- **File**: `ojtdashboard.html` / `ojtdashboard.js`
- **Protected Page**: Requires valid authentication token
- **Auto-redirects** unauthenticated users to `loginpage.html`
- **User verification**: Only students can access the dashboard
- **Features**:
  - Overview with OJT stats and progress
  - QR Attendance scanner
  - DTR (Daily Time Record)
  - Weekly Journal submission
  - Duty Log tracker
  - Progress visualization
  - Document downloads
  - Profile settings

### 3. **Backend API Routes** ✅

#### Authentication Routes (`/api/auth`)
```
POST /api/auth/register    - Register new user (student/coordinator/supervisor)
POST /api/auth/verify-2fa  - Confirm the authenticator app code to activate a new account
POST /api/auth/login       - Login and get JWT token
```

**Login/Register Response includes:**
- JWT token
- User ID
- Full Name
- Email
- Role
- Student ID (for students)
- Department (for students)
- Section (for students)

**Student & coordinator registration response instead includes** (the account stays
inactive until the code is confirmed, so no JWT is issued yet):
- `requiresTwoFactor: true`
- `setupToken` - short-lived (30 min) token that only works on `/api/auth/verify-2fa`
- `setupKey` - base32 secret to type into the authenticator app by hand
- `otpauthUrl` and `qrCode` (PNG data URL) - to scan with the app

Signing in before that code is confirmed returns `403` with `requiresTwoFactorSetup: true`
plus a fresh setup payload, so the setup screen can be shown again on the login page.

**School email rule:** students and coordinators must register with the STI email given
by the school. The campus domain `wnu.sti.edu.ph` is the only one accepted by default;
to allow more (or a different) domain, set `STI_EMAIL_DOMAINS` in `backend/.env`:

```
STI_EMAIL_DOMAINS=wnu.sti.edu.ph,sti.edu.ph
```

Supervisors keep their company email address and do not go through the app step.

#### Dashboard Routes (`/api/dashboard`)
```
GET  /api/dashboard/student/:studentId  - Get student dashboard data (Protected)
GET  /api/dashboard/profile             - Get current user profile (Protected)
PUT  /api/dashboard/profile             - Update user profile (Protected)
```

### 4. **MongoDB Collections** 📊

**Users Collection**:
- stores students, coordinators, and supervisors
- email uniqueness enforced
- passwords hashed with bcryptjs
- role-based access control

**Future Collections** (ready to implement):
- `attendance_records` - QR scan logs and time entries
- `journal_submissions` - Weekly journal entries
- `duty_logs` - Daily task logs
- `dtr_records` - Complete DTR history

### 5. **Security Features** 🔒
- JWT token validation on all protected routes
- Role-based authorization (students can only access student dashboard)
- Password hashing with bcryptjs (10 salt rounds)
- CORS enabled for frontend-backend communication
- Authenticator-app verification (TOTP / RFC 6238) for student and coordinator signups
- Short-lived setup tokens are rejected by every regular protected route
- Only whitelisted role fields are accepted on registration (no mass assignment)
- Environment variables for sensitive data (`.env` file)

### 6. **User Flow** 🔄

**New Student Registration:**
1. User navigates to `signup.html`
2. Selects "Student" role
3. Fills form with name, email, password, student ID, department
4. Submits to `POST /api/auth/register`
5. Backend creates user in MongoDB
6. Auto-saves JWT token & user data to localStorage
7. Auto-redirects to `ojtdashboard.html`

**Existing Student Login:**
1. User navigates to `loginpage.html`
2. Enters email and password
3. Submits to `POST /api/auth/login`
4. Backend verifies credentials against MongoDB
5. Returns JWT token
6. Frontend saves token & user data to localStorage
7. Auto-redirects to `ojtdashboard.html`

**Dashboard Access:**
1. User must have valid token + user data in localStorage
2. Must have role === 'student'
3. If not authenticated, redirects to login
4. All API calls include Authorization header with JWT token

---

## How to Run

### Backend Server
```bash
cd backend
npm install        # Install dependencies
npm run dev        # Start with nodemon (auto-reload)
# or
npm start          # Start normally
```
Server runs on `http://localhost:5000`

### Database
MongoDB must be running on `mongodb://localhost:27017`
(Configured in `backend/.env`)

### Frontend
Open any browser and navigate to:
- `http://localhost:3000` (if using live server)
- Or simply open `.html` files locally

---

## Testing

### Test the Flow:
1. Open `signup.html` → Create test student account
2. Dashboard auto-redirects after signup
3. Or go to `loginpage.html` → Login with created account
4. Access all 8 dashboard sections
5. Logout clears tokens and returns to login

### Test API:
```bash
# Register
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "John Doe",
    "email": "john@test.com",
    "password": "Test123",
    "role": "student",
    "studentId": "STI-2024-001",
    "department": "CICT"
  }'

# Login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "john@test.com", "password": "Test123"}'

# Get Dashboard Data (replace TOKEN and ID)
curl -X GET http://localhost:5000/api/dashboard/student/USER_ID \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Next Steps (Optional Enhancements)

1. **Implement Attendance Tracking**
   - Create QR code generator
   - Store attendance records in MongoDB
   - Calculate hours automatically

2. **Journal Storage**
   - Save journals to MongoDB
   - Implement approval workflow
   - Add NLP summarization API

3. **DTR Calculation**
   - Auto-calculate hours from attendance
   - Generate PDF reports with libraries like jsPDF

---

## Forgot Password (emailed code)

The "Forgot password?" link on `loginpage.html` opens a modal that walks the user
through three steps:

1. type the email they signed up with (the STI Microsoft account for students and
   coordinators)
2. type the 6-digit code that was emailed to that mailbox
3. choose a new password

### Endpoints

```
POST /api/auth/forgot-password   - { email }              -> emails a 6-digit code
POST /api/auth/verify-reset-code - { email, code }        -> { resetToken } (15 min JWT)
POST /api/auth/reset-password    - { newPassword } + Authorization: Bearer <resetToken>
```

For an unknown address `forgot-password` answers exactly like a successful send, so
the endpoint cannot be used to discover which emails are registered. Sending again
before `RESEND_COOLDOWN_SECONDS` (60s) returns `429` with `retryAfterSeconds`.

### Email delivery (Microsoft Graph)

`backend/services/emailService.js` sends through Microsoft Graph `sendMail` with an
app-only token - no extra npm package needed. Add to `backend/.env`:

```
MS_TENANT_ID=          # Azure AD tenant id (or <tenant>.onmicrosoft.com)
MS_CLIENT_ID=          # app registration (client) id
MS_CLIENT_SECRET=      # app registration client secret
MS_SENDER_EMAIL=no-reply@wnu.sti.edu.ph
MS_SENDER_NAME=TrackIT
```

In Azure AD: register an app, add the **application** permission `Mail.Send` and
grant admin consent. Because that permission covers the whole tenant, restrict it to
the sending mailbox with an Application Access Policy:

```powershell
New-ApplicationAccessPolicy -AppId <client id> `
  -PolicyScopeGroupId <mail-enabled security group> `
  -AccessRight RestrictAccess -Description "TrackIT password reset mail"
```

**Development fallback:** when those variables are missing, the API logs the code on
the server console (`[password-reset] ... Reset code for <email> is <code>`) and, while
`NODE_ENV` is not `production`, also returns it as `devCode` so the modal can show it.
Set `NODE_ENV=production` on the deployed server so codes are never sent to the browser.

### Security notes

- only a bcrypt hash of the code is stored (`passwordResetCodeHash`), together with a
  10 minute expiry, an attempt counter (5 wrong tries invalidate the code) and the
  last request time used for the resend cooldown
- the reset token is a 15 minute JWT with `purpose: 'password-reset'`, which every
  regular protected route rejects (`authenticateToken` refuses purpose-scoped tokens)
- the code is single use: it is deleted as soon as the new password is saved
- existing 7-day session tokens are not revoked by a reset (JWT is stateless)

4. **Email Notifications**
   - Send verification emails
   - Notify supervisors of submissions
   - Password reset via email

5. **User Roles Dashboard**
   - Create coordinator-dashboard.html
   - Create supervisor-dashboard.html
   - Role-specific features and views

---

## File Structure

```
trackIt2/
├── backend/
│   ├── middleware/
│   │   ├── auth.js              ← NEW: JWT verification
│   │   ├── errorHandler.js
│   ├── routes/
│   │   ├── auth.js              ← UPDATED: Return more user data
│   │   ├── dashboard.js         ← NEW: Dashboard API routes
│   ├── models/
│   │   ├── User.js
│   ├── config/
│   │   ├── db.js
│   ├── server.js                ← UPDATED: Added dashboard routes
│   ├── package.json
│   ├── .env
├── ojtdashboard.html            ← UPDATED: Auth check added
├── ojtdashboard.js              ← UPDATED: API integration
├── loginpage.js                 ← UPDATED: Redirect to ojtdashboard
├── signup.js                    ← UPDATED: Auto-login after signup
├── visuals/
│   ├── ojtdashboard.css
```

---

**Status**: ✅ All authentication and MongoDB integration complete!
Users must now login before accessing the OJT dashboard.
