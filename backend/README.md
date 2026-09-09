# TrackIT Backend

OJT Monitoring Platform Backend - Node.js + Express + MongoDB

## Setup Instructions

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the `backend` folder:

```bash
cp .env.example .env
```

Edit `.env` and update:
```
MONGODB_URI=mongodb://localhost:27017/trackit
PORT=5000
JWT_SECRET=your_secure_secret_key_here
NODE_ENV=development
```

### 3. MongoDB Setup

Make sure MongoDB is running locally:
```bash
# Windows
mongod

# macOS/Linux
brew services start mongodb-community
```

### 4. Start the Server

Development mode (with auto-reload):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

## API Endpoints

### Authentication

#### Register User
**POST** `/api/auth/register`

Request body:
```json
{
  "fullName": "Juan Dela Cruz",
  "email": "juan@example.com",
  "password": "password123",
  "role": "student",
  "studentId": "2024-00123",
  "department": "CICT",
  "companyName": "TechCorp"
}
```

Roles and required fields:

**Student:**
- `studentId` (required)
- `department` (required)
- `companyName` (optional)

**Coordinator:**
- `department` (required)

**Supervisor:**
- `companyName` (required)
- `companyPosition` (required)
- `companyDepartment` (optional)

Response:
```json
{
  "success": true,
  "message": "User registered successfully",
  "token": "eyJhbGc...",
  "user": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Juan Dela Cruz",
    "email": "juan@example.com",
    "role": "student"
  }
}
```

#### Login User
**POST** `/api/auth/login`

Request body:
```json
{
  "email": "juan@example.com",
  "password": "password123"
}
```

Response:
```json
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGc...",
  "user": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Juan Dela Cruz",
    "email": "juan@example.com",
    "role": "student"
  }
}
```

#### Health Check
**GET** `/api/health`

## Database Schema

### Users Collection

The `users` collection uses a **polymorphic pattern** to store all user types (student, coordinator, supervisor) in a single collection with role-specific fields:

```javascript
{
  _id: ObjectId,
  fullName: String,
  email: String (unique),
  password: String (hashed),
  role: String (enum: student, coordinator, supervisor),
  isActive: Boolean,
  createdAt: Date,
  updatedAt: Date,
  
  // Student-specific
  studentId: String,
  department: String,
  companyName: String,
  
  // Coordinator-specific
  coordinatorDepartment: String,
  
  // Supervisor-specific
  companyPosition: String,
  companyDepartment: String
}
```

**Indexes:**
- `email` (unique)
- `role`
- `createdAt` (descending)

## Notes

- Passwords are automatically hashed using bcryptjs before storage
- JWT tokens expire in 7 days
- All email addresses are stored in lowercase for consistency
- Invalid duplicate emails return a 400 error
