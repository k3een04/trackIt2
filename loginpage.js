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
        // The account exists but its authenticator app was never confirmed
        if (data.requiresTwoFactorSetup) {
          if (submitBtn) submitBtn.disabled = false;
          if (submitText) submitText.textContent = 'Sign In';
          startLoginVerification(data);
          return;
        }

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

// ── Authenticator app verification ────────────────────────────────────────
// Shown when sign-in reports that a signup never confirmed its authenticator app.
let loginTwoFactorToken = null;

function startLoginVerification(setup) {
  loginTwoFactorToken = setup.setupToken || null;

  const qrEl = document.getElementById('loginTotpQr');
  if (qrEl) qrEl.src = setup.qrCode || '';

  const keyEl = document.getElementById('loginTotpKey');
  if (keyEl) keyEl.textContent = setup.setupKey || '';

  const accountEl = document.getElementById('loginVerifyAccount');
  if (accountEl && setup.account && setup.account.email) {
    accountEl.textContent = setup.account.email;
  }

  setLoginVerifyMessage('');

  const form = document.getElementById('loginForm');
  if (form) form.classList.add('hidden');

  const panel = document.getElementById('loginStepVerify');
  if (panel) panel.classList.remove('hidden');

  const codeInput = document.getElementById('loginTotpCode');
  if (codeInput) {
    codeInput.value = '';
    codeInput.focus();
  }
}

function cancelLoginVerification() {
  loginTwoFactorToken = null;

  const panel = document.getElementById('loginStepVerify');
  if (panel) panel.classList.add('hidden');

  const form = document.getElementById('loginForm');
  if (form) form.classList.remove('hidden');

  const password = document.getElementById('loginPassword');
  if (password) password.value = '';
}

function setLoginVerifyMessage(message, isSuccess = false) {
  const el = document.getElementById('loginTotpError');
  if (!el) return;

  if (!message) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }

  el.className = 'mb-4 p-3.5 rounded-xl text-sm border ' + (isSuccess
    ? 'bg-teal-500/10 border-teal-500/30 text-teal-300'
    : 'bg-red-500/10 border-red-500/30 text-red-300');
  el.textContent = message;
}

async function submitLoginVerificationCode() {
  const codeInput = document.getElementById('loginTotpCode');
  const code = codeInput ? codeInput.value.replace(/\D/g, '') : '';
  const btn = document.getElementById('loginVerifyBtn');
  const textEl = document.getElementById('loginVerifyText');
  const spinner = document.getElementById('loginVerifySpinner');

  if (code.length !== 6) {
    setLoginVerifyMessage('Enter the 6-digit code shown in your authenticator app.');
    return;
  }

  if (!loginTwoFactorToken) {
    setLoginVerifyMessage('Your verification session has expired. Please sign in again.');
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
        'Authorization': `Bearer ${loginTwoFactorToken}`
      },
      body: JSON.stringify({ code })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || 'Could not verify that code.');
    }

    setLoginVerifyMessage('✅ ' + (data.message || 'Authenticator app confirmed!') + ' You can sign in now.', true);
    textEl.textContent = 'Verified';
    spinner.classList.add('hidden');

    setTimeout(() => {
      cancelLoginVerification();
      const emailInput = document.getElementById('loginEmail');
      if (emailInput) emailInput.focus();
    }, 2200);
  } catch (err) {
    setLoginVerifyMessage(err.message);
    btn.disabled = false;
    textEl.textContent = 'Verify & Activate Account';
    spinner.classList.add('hidden');
    if (codeInput) codeInput.select();
  }
}

const loginVerifyBtn = document.getElementById('loginVerifyBtn');
if (loginVerifyBtn) {
  loginVerifyBtn.addEventListener('click', submitLoginVerificationCode);
}

const loginVerifyCancel = document.getElementById('loginVerifyCancel');
if (loginVerifyCancel) {
  loginVerifyCancel.addEventListener('click', cancelLoginVerification);
}

// Authenticator code field: digits only, Enter submits
const loginTotpCodeInput = document.getElementById('loginTotpCode');
if (loginTotpCodeInput) {
  loginTotpCodeInput.addEventListener('input', () => {
    loginTotpCodeInput.value = loginTotpCodeInput.value.replace(/\D/g, '').slice(0, 6);
  });
  loginTotpCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitLoginVerificationCode();
    }
  });
}
