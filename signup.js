// Clear any old auth data to prevent auto-redirects
localStorage.removeItem('trackit_token');
localStorage.removeItem('trackit_user');

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
  const body = {
    fullName: document.getElementById('fullName').value,
    email:    document.getElementById('email').value,
    password,
    role:     selectedRole,
  };

  if (selectedRole === 'student') {
    body.studentId   = document.getElementById('studentId').value;
    body.department  = document.getElementById('department-student').value;
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
