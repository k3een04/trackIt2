// ── Password strength checker ─────────────────────────────────────────────
function checkPasswordStrength(password) {
  let strength = 0;
  const bars = [
    document.getElementById('bar1'),
    document.getElementById('bar2'),
    document.getElementById('bar3')
  ];
  const strengthText = document.getElementById('strengthText');

  if (password.length >= 8)  strength++;
  if (password.length >= 12) strength++;
  if (/[A-Z]/.test(password)) strength++;
  if (/[0-9]/.test(password)) strength++;
  if (/[!@#$%^&*]/.test(password)) strength++;

  let level = 'weak';
  let filledBars = Math.ceil(strength / 2);
  if (strength >= 4) { level = 'strong';  filledBars = 3; }
  else if (strength >= 2) { level = 'medium'; filledBars = 2; }

  bars.forEach((bar, i) => {
    bar.className = i < filledBars ? `strength-bar ${level}` : 'strength-bar';
  });
  strengthText.className = `strength-text ${level}`;
  strengthText.textContent = `Password strength: ${level.charAt(0).toUpperCase() + level.slice(1)}`;
}

// ── Role selection ────────────────────────────────────────────────────────
let selectedRole = null;

function selectRole(role) {
  selectedRole = role;
  document.getElementById('roleInput').value = role;

  // Highlight selected role button
  document.querySelectorAll('.role-btn').forEach(el => el.classList.remove('active'));
  const selectedBtn = document.querySelector(`.role-btn[data-role="${role}"]`);
  if (selectedBtn) selectedBtn.classList.add('active');

  // Update badge
  const badge = document.getElementById('selected-role-badge');
  const labels = {
    student: ' OJT Student',
    coordinator: ' OJT Coordinator',
    supervisor: ' Company Supervisor'
  };
  badge.textContent = labels[role];
  badge.className = `role-badge ${role}`;

  // Show/hide role-specific fields
  document.querySelectorAll('.role-fields').forEach(el => el.style.display = 'none');
  const fieldEl = document.getElementById(`fields-${role}`);
  if (fieldEl) fieldEl.style.display = 'block';

  // Highlight left panel info card
  document.querySelectorAll('.role-info-card').forEach(el => el.classList.remove('active'));
  const infoEl = document.getElementById(`info-${role}`);
  if (infoEl) infoEl.classList.add('active');

  // Students and coordinators must sign up with their STI email address
  const emailHint = document.getElementById('email-hint');
  if (emailHint) emailHint.style.display = requiresSchoolEmail(role) ? 'block' : 'none';

  // Switch steps
  document.getElementById('step-role').style.display = 'none';
  document.getElementById('step-form').style.display = 'block';
  document.getElementById('step-form').classList.add('form-animate');
}

function goBackToRole() {
  selectedRole = null;
  document.getElementById('step-role').style.display = 'block';
  document.getElementById('step-form').style.display = 'none';
  document.querySelectorAll('.role-btn').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.role-info-card').forEach(el => el.classList.remove('active'));
}

// ── Form submission ───────────────────────────────────────────────────────
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '5000' && window.location.port !== ''
  ? 'http://localhost:5000/api'
  : '/api';

// ── School email policy ───────────────────────────────────────────────────
// STI accounts look like delacruz.873612@ortigas-cainta.edu.ph (older ones
// used @sti.ph). The server is the final authority; this check is for UX.
const SCHOOL_EMAIL_PATTERN = /@([a-z0-9-]+\.)*(edu\.ph|sti\.ph)$/i;
const SCHOOL_EMAIL_MESSAGE = 'Please use your STI email address (example: delacruz.873612@ortigas-cainta.edu.ph).';

function requiresSchoolEmail(role) {
  return role === 'student' || role === 'coordinator';
}

// Token handed out by the server for the authenticator-app confirmation step
let twoFactorSetupToken = null;

document.getElementById('signupForm')?.addEventListener('submit', async function(e) {
  e.preventDefault();
  
  console.log('🔵 Form submitted');

  const password        = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirmPassword').value;
  const errorMsg        = document.getElementById('errorMsg');
  const submitBtn       = document.getElementById('submitBtn');
  const submitText      = document.getElementById('submitText');
  const submitSpinner   = document.getElementById('submitSpinner');
  const submitArrow     = document.getElementById('submitArrow');

  // Password match check
  if (password !== confirmPassword) {
    console.warn('⚠️ Passwords do not match');
    document.getElementById('passwordMismatch').classList.remove('hidden');
    return;
  }
  document.getElementById('passwordMismatch').classList.add('hidden');

  // Collect form data
  const email = document.getElementById('email').value.trim();

  // Students and coordinators must use the STI email given by the school
  if (requiresSchoolEmail(selectedRole) && !SCHOOL_EMAIL_PATTERN.test(email)) {
    errorMsg.textContent = SCHOOL_EMAIL_MESSAGE;
    errorMsg.classList.remove('hidden');
    errorMsg.classList.remove('success-msg');
    errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const body = {
    fullName: document.getElementById('fullName').value,
    email,
    password,
    role:     selectedRole,
  };

  if (selectedRole === 'student') {
    body.studentId   = document.getElementById('studentId').value;
    body.department  = document.getElementById('department-student').value;
    body.section     = document.getElementById('section').value;
  }
  if (selectedRole === 'coordinator') {
    body.department  = document.getElementById('department-coordinator').value;
  }
  if (selectedRole === 'supervisor') {
    body.companyName       = document.getElementById('companyName-supervisor').value;
    body.companyPosition   = document.getElementById('companyPosition').value;
  }

  // Loading state
  submitBtn.disabled    = true;
  submitText.textContent = 'Creating account…';
  submitArrow.classList.add('hidden');
  submitSpinner.classList.remove('hidden');
  errorMsg.classList.add('hidden');

  try {
    console.log('📤 Sending signup data:', body);
    
    const res  = await fetch(`${API_BASE}/auth/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    
    console.log('📨 Response status:', res.status);
    const data = await res.json();
    console.log('📥 Response data:', data);

    if (!res.ok) {
      throw new Error(data.message || 'Registration failed.');
    }

    console.log('✅ Registration successful!');

    // Students and coordinators must confirm a code from their authenticator app
    if (data.requiresTwoFactor) {
      startAuthenticatorVerification(data);
      return;
    }
    
    // Show success message with better visibility
    errorMsg.textContent = '✅ Account created successfully! Redirecting to login page...';
    errorMsg.classList.remove('hidden');
    errorMsg.classList.add('success-msg');
    
    // Scroll to show the message
    errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
  

    // Redirect to login page after 1.5 seconds
    setTimeout(() => {
      window.location.href = 'loginpage.html';
    }, 1500);
  } catch (err) {
    console.error('❌ Registration error:', err.message);
    errorMsg.textContent = err.message;
    errorMsg.classList.remove('hidden');
    errorMsg.classList.remove('success-msg');
    submitBtn.disabled    = false;
    submitText.textContent = 'Create Account';
    submitArrow.classList.remove('hidden');
    submitSpinner.classList.add('hidden');
  }
});

// ── Authenticator app verification ────────────────────────────────────────
// Shown when the server answers with requiresTwoFactor: the account exists but
// is inactive until a code generated by their authenticator app is confirmed.
function startAuthenticatorVerification(setup) {
  twoFactorSetupToken = setup.setupToken || null;

  const qrEl = document.getElementById('totp-qr');
  if (qrEl) qrEl.src = setup.qrCode || '';

  const keyEl = document.getElementById('totp-key');
  if (keyEl) keyEl.textContent = setup.setupKey || '';

  const accountEl = document.getElementById('verify-account-email');
  if (accountEl) {
    accountEl.textContent = setup.account && setup.account.email
      ? setup.account.email
      : 'One last step to activate your account';
  }

  const form = document.getElementById('signupForm');
  if (form) form.style.display = 'none';

  const verifyStep = document.getElementById('step-verify');
  if (verifyStep) verifyStep.style.display = 'block';

  const codeInput = document.getElementById('totp-code');
  if (codeInput) {
    codeInput.value = '';
    codeInput.focus();
  }

  if (verifyStep) verifyStep.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function verifyAuthenticatorCode() {
  const codeInput = document.getElementById('totp-code');
  const code = codeInput ? codeInput.value.replace(/\D/g, '') : '';
  const errorEl = document.getElementById('totpError');
  const btn = document.getElementById('verifyBtn');
  const textEl = document.getElementById('verifyText');
  const spinner = document.getElementById('verifySpinner');

  if (errorEl) {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }

  if (code.length !== 6) {
    showVerificationError('Enter the 6-digit code shown in your authenticator app.');
    return;
  }

  if (!twoFactorSetupToken) {
    showVerificationError('Your verification session has expired. Please sign up again.');
    return;
  }

  btn.disabled = true;
  textEl.textContent = 'Verifying…';
  spinner.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/auth/verify-2fa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${twoFactorSetupToken}`
      },
      body: JSON.stringify({ code })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || 'Could not verify that code.');
    }

    console.log('✅ Authenticator app verified');

    errorEl.textContent = '✅ ' + (data.message || 'Authenticator app confirmed!') + ' Redirecting to the login page…';
    errorEl.classList.remove('hidden');
    errorEl.classList.add('success-msg');
    textEl.textContent = 'Verified';
    spinner.classList.add('hidden');

    setTimeout(() => {
      window.location.href = 'loginpage.html';
    }, 1800);
  } catch (err) {
    console.error('❌ Verification error:', err.message);
    showVerificationError(err.message);
    btn.disabled = false;
    textEl.textContent = 'Verify & Activate Account';
    spinner.classList.add('hidden');
    if (codeInput) codeInput.select();
  }
}

function showVerificationError(message) {
  const errorEl = document.getElementById('totpError');
  if (!errorEl) {
    alert(message);
    return;
  }

  errorEl.textContent = message;
  errorEl.classList.remove('success-msg');
  errorEl.classList.remove('hidden');
}

// Authenticator code field: digits only, Enter submits
const totpCodeInput = document.getElementById('totp-code');
if (totpCodeInput) {
  totpCodeInput.addEventListener('input', () => {
    totpCodeInput.value = totpCodeInput.value.replace(/\D/g, '').slice(0, 6);
  });
  totpCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      verifyAuthenticatorCode();
    }
  });
}
