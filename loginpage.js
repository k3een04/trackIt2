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

// ── Forgot password modal ─────────────────────────────────────────────────
// 1) the user types the school (Microsoft) email they signed up with
// 2) the backend emails a 6-digit code, which they type back in
// 3) the code is exchanged for a short-lived reset token that sets a new password
const forgotModal = document.getElementById('forgotModal');
const forgotSteps = {
  email: document.getElementById('forgotStepEmail'),
  code: document.getElementById('forgotStepCode'),
  reset: document.getElementById('forgotStepReset'),
  done: document.getElementById('forgotStepDone'),
};

let forgotEmail = '';        // address the code was sent to
let forgotResetToken = null; // token returned by /auth/verify-reset-code
let forgotResendTimer = null;
let forgotResendSeconds = 0;
const RESET_CODE_LENGTH = 6;
const RESEND_WAIT_SECONDS = 60;

function forgotShowStep(step) {
  Object.entries(forgotSteps).forEach(([name, el]) => {
    if (!el) return;
    el.classList.toggle('hidden', name !== step);
  });
  if (forgotModal) forgotModal.scrollTop = 0;
}

function forgotSetMessage(elId, message, isSuccess = false) {
  const el = document.getElementById(elId);
  if (!el) return;

  if (!message) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }

  el.className = 'mt-4 p-3.5 rounded-xl text-sm border ' + (isSuccess
    ? 'bg-teal-500/10 border-teal-500/30 text-teal-300'
    : 'bg-red-500/10 border-red-500/30 text-red-300');
  el.textContent = message;
}

function forgotBusy(prefix, busy, idleLabel, busyLabel) {
  const btn = document.getElementById(`${prefix}Btn`);
  const textEl = document.getElementById(`${prefix}Text`);
  const spinner = document.getElementById(`${prefix}Spinner`);

  if (btn) btn.disabled = busy;
  if (textEl) textEl.textContent = busy ? busyLabel : idleLabel;
  if (spinner) spinner.classList.toggle('hidden', !busy);
}

function stopForgotResendTimer() {
  if (forgotResendTimer) {
    clearInterval(forgotResendTimer);
    forgotResendTimer = null;
  }
  forgotResendSeconds = 0;
}

function startForgotResendTimer(seconds = RESEND_WAIT_SECONDS) {
  const btn = document.getElementById('forgotResendBtn');
  if (!btn) return;

  stopForgotResendTimer();
  forgotResendSeconds = Number(seconds) > 0 ? Number(seconds) : RESEND_WAIT_SECONDS;
  btn.disabled = true;

  const tick = () => {
    if (forgotResendSeconds <= 0) {
      stopForgotResendTimer();
      btn.disabled = false;
      btn.textContent = 'Resend code';
      return;
    }

    btn.textContent = `Resend in ${forgotResendSeconds}s`;
    forgotResendSeconds -= 1;
  };

  tick();
  forgotResendTimer = setInterval(tick, 1000);
}

function openForgotModal() {
  if (!forgotModal) return;

  forgotResetToken = null;
  stopForgotResendTimer();
  forgotShowStep('email');
  forgotSetMessage('forgotError', '');
  forgotSetMessage('forgotCodeError', '');
  forgotSetMessage('forgotResetError', '');

  const devHint = document.getElementById('forgotDevHint');
  if (devHint) {
    devHint.className = 'hidden';
    devHint.textContent = '';
  }

  const emailEl = document.getElementById('forgotEmail');
  if (emailEl && !emailEl.value) {
    const typedEmail = document.getElementById('loginEmail');
    emailEl.value = typedEmail ? typedEmail.value : '';
  }

  ['forgotCode', 'forgotNewPassword', 'forgotConfirmPassword'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  forgotModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  if (emailEl) emailEl.focus();
}

function closeForgotModal() {
  if (!forgotModal) return;

  forgotModal.classList.add('hidden');
  document.body.style.overflow = '';
  forgotResetToken = null;
  stopForgotResendTimer();

  const trigger = document.getElementById('forgotPasswordBtn');
  if (trigger) trigger.focus();
}

async function forgotRequestCode(options = {}) {
  const isResend = Boolean(options.isResend);
  const emailEl = document.getElementById('forgotEmail');
  const email = emailEl ? emailEl.value.trim().toLowerCase() : '';
  const messageId = isResend ? 'forgotCodeError' : 'forgotError';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    forgotSetMessage(messageId, 'Enter the email address you used for your TrackIT account.');
    return;
  }

  forgotSetMessage('forgotError', '');
  forgotSetMessage('forgotCodeError', '');
  forgotBusy('forgotSend', true, 'Send Reset Code', 'Sending...');

  try {
    const res = await fetch(`${API_BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || 'We could not send the reset code. Please try again.');
    }

    forgotEmail = email;

    const sentTo = document.getElementById('forgotSentTo');
    if (sentTo) sentTo.textContent = email;

    const account = document.getElementById('forgotResetAccount');
    if (account) account.textContent = email;

    const ttl = document.getElementById('forgotCodeTtl');
    if (ttl && data.codeExpiresInMinutes) ttl.textContent = `${data.codeExpiresInMinutes} minutes`;

    forgotShowStep('code');
    forgotSetMessage('forgotCodeError', data.message || `We sent a code to ${email}.`, true);
    startForgotResendTimer(RESEND_WAIT_SECONDS);

    // Without Microsoft Graph credentials the API returns the code so the flow
    // can still be exercised in development.
    const devHint = document.getElementById('forgotDevHint');
    if (devHint) {
      if (data.devCode) {
        devHint.className = 'mt-4 p-3.5 rounded-xl text-sm border bg-amber-500/10 border-amber-500/30 text-amber-300';
        devHint.textContent = `Development mode: email delivery is not configured, so use this code: ${data.devCode}`;
      } else {
        devHint.className = 'hidden';
        devHint.textContent = '';
      }
    }

    const codeEl = document.getElementById('forgotCode');
    if (codeEl) {
      codeEl.value = '';
      codeEl.focus();
    }
  } catch (err) {
    forgotSetMessage(messageId, err.message);
  } finally {
    forgotBusy('forgotSend', false, 'Send Reset Code', 'Sending...');
  }
}

async function forgotVerifyCode() {
  const codeEl = document.getElementById('forgotCode');
  const code = codeEl ? codeEl.value.replace(/\D/g, '') : '';

  if (code.length !== RESET_CODE_LENGTH) {
    forgotSetMessage('forgotCodeError', `Enter the ${RESET_CODE_LENGTH}-digit code from your email.`);
    return;
  }

  if (!forgotEmail) {
    forgotSetMessage('forgotCodeError', 'Request a new code first.');
    return;
  }

  forgotSetMessage('forgotCodeError', '');
  forgotBusy('forgotVerify', true, 'Verify Code', 'Verifying...');

  try {
    const res = await fetch(`${API_BASE}/auth/verify-reset-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: forgotEmail, code }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || 'That code is not correct.');
    }

    forgotResetToken = data.resetToken || null;
    stopForgotResendTimer();

    const account = document.getElementById('forgotResetAccount');
    if (account) account.textContent = (data.account && data.account.email) || forgotEmail;

    forgotShowStep('reset');

    const pwdEl = document.getElementById('forgotNewPassword');
    const confirmEl = document.getElementById('forgotConfirmPassword');
    if (pwdEl) pwdEl.value = '';
    if (confirmEl) confirmEl.value = '';
    if (pwdEl) pwdEl.focus();
  } catch (err) {
    forgotSetMessage('forgotCodeError', err.message);
  } finally {
    forgotBusy('forgotVerify', false, 'Verify Code', 'Verifying...');
  }
}

async function forgotSubmitNewPassword() {
  const pwdEl = document.getElementById('forgotNewPassword');
  const confirmEl = document.getElementById('forgotConfirmPassword');
  const newPassword = pwdEl ? pwdEl.value : '';
  const confirmPassword = confirmEl ? confirmEl.value : '';

  if (newPassword.length < 6) {
    forgotSetMessage('forgotResetError', 'Your new password must be at least 6 characters.');
    return;
  }

  if (newPassword !== confirmPassword) {
    forgotSetMessage('forgotResetError', 'The two passwords do not match.');
    return;
  }

  if (!forgotResetToken) {
    forgotSetMessage('forgotResetError', 'Your reset session expired. Request a new code and try again.');
    return;
  }

  forgotSetMessage('forgotResetError', '');
  forgotBusy('forgotReset', true, 'Reset Password', 'Saving...');

  try {
    const res = await fetch(`${API_BASE}/auth/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${forgotResetToken}`,
      },
      body: JSON.stringify({ newPassword }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || 'We could not update your password. Please try again.');
    }

    // Prefill the sign-in form so the user can log straight in
    const loginEmailEl = document.getElementById('loginEmail');
    if (loginEmailEl) loginEmailEl.value = forgotEmail;

    const loginPasswordEl = document.getElementById('loginPassword');
    if (loginPasswordEl) loginPasswordEl.value = '';

    const doneText = document.getElementById('forgotDoneText');
    if (doneText) doneText.textContent = data.message || 'You can now sign in with your new password.';

    forgotResetToken = null;
    forgotShowStep('done');
  } catch (err) {
    forgotSetMessage('forgotResetError', err.message);
  } finally {
    forgotBusy('forgotReset', false, 'Reset Password', 'Saving...');
  }
}

// ── Forgot password wiring ────────────────────────────────────────────────
const forgotTriggerBtn = document.getElementById('forgotPasswordBtn');
if (forgotTriggerBtn) {
  forgotTriggerBtn.addEventListener('click', () => openForgotModal());
}

// Keeps the old #forgot deep link working
if (window.location.hash === '#forgot') {
  openForgotModal();
}

const forgotCloseBtn = document.getElementById('forgotModalClose');
if (forgotCloseBtn) {
  forgotCloseBtn.addEventListener('click', closeForgotModal);
}

const forgotSendBtn = document.getElementById('forgotSendBtn');
if (forgotSendBtn) {
  forgotSendBtn.addEventListener('click', () => forgotRequestCode());
}

const forgotResendBtn = document.getElementById('forgotResendBtn');
if (forgotResendBtn) {
  forgotResendBtn.addEventListener('click', () => forgotRequestCode({ isResend: true }));
}

const forgotBackBtn = document.getElementById('forgotBackBtn');
if (forgotBackBtn) {
  forgotBackBtn.addEventListener('click', () => {
    stopForgotResendTimer();
    forgotResetToken = null;
    forgotSetMessage('forgotError', '');
    forgotSetMessage('forgotCodeError', '');
    forgotShowStep('email');

    const emailEl = document.getElementById('forgotEmail');
    if (emailEl) emailEl.focus();
  });
}

const forgotVerifyBtn = document.getElementById('forgotVerifyBtn');
if (forgotVerifyBtn) {
  forgotVerifyBtn.addEventListener('click', forgotVerifyCode);
}

const forgotResetBtn = document.getElementById('forgotResetBtn');
if (forgotResetBtn) {
  forgotResetBtn.addEventListener('click', forgotSubmitNewPassword);
}

const forgotCancelBtn = document.getElementById('forgotCancelBtn');
if (forgotCancelBtn) {
  forgotCancelBtn.addEventListener('click', closeForgotModal);
}

const forgotDoneBtn = document.getElementById('forgotDoneBtn');
if (forgotDoneBtn) {
  forgotDoneBtn.addEventListener('click', () => {
    closeForgotModal();
    const passwordEl = document.getElementById('loginPassword');
    if (passwordEl) passwordEl.focus();
  });
}

// Backdrop click closes the modal
if (forgotModal) {
  forgotModal.addEventListener('click', (event) => {
    if (event.target === forgotModal) closeForgotModal();
  });
}

// Escape closes the modal, Enter submits the current step
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && forgotModal && !forgotModal.classList.contains('hidden')) {
    closeForgotModal();
  }
});

const forgotEmailInput = document.getElementById('forgotEmail');
if (forgotEmailInput) {
  forgotEmailInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      forgotRequestCode();
    }
  });
}

const forgotCodeInput = document.getElementById('forgotCode');
if (forgotCodeInput) {
  forgotCodeInput.addEventListener('input', () => {
    forgotCodeInput.value = forgotCodeInput.value.replace(/\D/g, '').slice(0, RESET_CODE_LENGTH);
  });
  forgotCodeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      forgotVerifyCode();
    }
  });
}

const forgotConfirmInput = document.getElementById('forgotConfirmPassword');
if (forgotConfirmInput) {
  forgotConfirmInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      forgotSubmitNewPassword();
    }
  });
}
