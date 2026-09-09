const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '5000' && window.location.port !== ''
  ? 'http://localhost:5000/api'
  : '/api';

// ── Redirect if already logged in ────────────────────────────────────────
(function checkAuth() {
  try {
    const token = localStorage.getItem('trackit_token');
    const user  = JSON.parse(localStorage.getItem('trackit_user') || 'null');
    if (token && user && user.role) {
      const validRoles = ['student', 'coordinator', 'supervisor'];
      if (validRoles.includes(user.role)) {
        redirectToDashboard(user.role);
      }
    }
  } catch (e) {
    console.error('Auth check error:', e);
  }
})();

// ── Toggle Password Visibility ───────────────────────────────────────────
const togglePasswordBtn = document.getElementById('togglePasswordBtn');
const passwordInput = document.getElementById('loginPassword');
const eyeIcon = document.getElementById('eyeIcon');

if (togglePasswordBtn && passwordInput) {
  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    
    if (eyeIcon) {
      if (isPassword) {
        // Eye off icon
        eyeIcon.innerHTML = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>`;
      } else {
        // Eye on icon
        eyeIcon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
      }
    }
  });
}

// ── Restore Remembered Email ──────────────────────────────────────────────
const rememberedEmail = localStorage.getItem('trackit_remembered_email');
const emailInputEl = document.getElementById('loginEmail');
const rememberCheckboxEl = document.getElementById('rememberMe');

if (rememberedEmail && emailInputEl) {
  emailInputEl.value = rememberedEmail;
  if (rememberCheckboxEl) rememberCheckboxEl.checked = true;
}

// ── Form submission ───────────────────────────────────────────────────────
const loginForm = document.getElementById('loginForm');
if (loginForm) {
  loginForm.addEventListener('submit', async function(e) {
    e.preventDefault();

    const emailInput    = document.getElementById('loginEmail') || this.querySelector('input[type="email"]');
    const passwordInput = document.getElementById('loginPassword') || this.querySelector('input[type="password"]');
    const submitBtn     = document.getElementById('loginSubmitBtn') || this.querySelector('button[type="submit"]');
    const submitText    = document.getElementById('loginSubmitText');
    const errorEl       = document.getElementById('loginError');
    const errorTextEl   = document.getElementById('loginErrorText');
    const rememberMe    = document.getElementById('rememberMe')?.checked;

    const email    = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!email || !password) {
      showError('Please enter your email and password.', errorEl, errorTextEl);
      return;
    }

    // Hide previous error
    if (errorEl) {
      errorEl.classList.add('hidden');
      if (errorTextEl) errorTextEl.textContent = '';
    }

    // Remember me handling
    if (rememberMe) {
      localStorage.setItem('trackit_remembered_email', email);
    } else {
      localStorage.removeItem('trackit_remembered_email');
    }

    // Loading state
    if (submitBtn) submitBtn.disabled = true;
    if (submitText) submitText.textContent = 'Signing in…';

    try {
      const res  = await fetch(`${API_BASE}/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Login failed. Please check your credentials.');
      }

      localStorage.setItem('trackit_token', data.token);
      localStorage.setItem('trackit_user',  JSON.stringify(data.user));
      localStorage.removeItem('trackit_current_tab');

      redirectToDashboard(data.user.role);
    } catch (err) {
      showError(err.message, errorEl, errorTextEl);
      if (submitBtn) submitBtn.disabled = false;
      if (submitText) submitText.textContent = 'Sign In';
    }
  });
}

function showError(msg, el, textEl) {
  if (el) {
    if (textEl) {
      textEl.textContent = msg;
    } else {
      el.textContent = msg;
    }
    el.classList.remove('hidden');
    return;
  }
  let fallbackEl = document.getElementById('loginError');
  if (!fallbackEl) {
    const form = document.getElementById('loginForm');
    if (form) {
      fallbackEl = document.createElement('div');
      fallbackEl.id = 'loginError';
      fallbackEl.className = 'p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300 text-sm mb-4';
      form.prepend(fallbackEl);
    }
  }
  if (fallbackEl) {
    fallbackEl.textContent = msg;
    fallbackEl.classList.remove('hidden');
  } else {
    alert(msg);
  }
}

function redirectToDashboard(role) {
  const map = {
    student:     'ojtdashboard.html',
    coordinator: 'coordinator-dashboard.html',
    supervisor:  'supervisor-dashboard.html'
  };
  window.location.href = map[role] || 'landingpage.html';
}
