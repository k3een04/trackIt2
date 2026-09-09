const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '5000' && window.location.port !== ''
  ? 'http://localhost:5000/api'
  : '/api';

// ── Redirect if already logged in ────────────────────────────────────────
(function checkAuth() {
  const token = localStorage.getItem('trackit_token');
  const user  = JSON.parse(localStorage.getItem('trackit_user') || 'null');
  if (token && user) {
    redirectToDashboard(user.role);
  }
})();

// ── Reveal animations on load ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.reveal').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
  });
});

// ── Form submission ───────────────────────────────────────────────────────
document.getElementById('loginForm')?.addEventListener('submit', async function(e) {
  e.preventDefault();

  const emailInput    = this.querySelector('input[type="email"]');
  const passwordInput = this.querySelector('input[type="password"]');
  const submitBtn     = this.querySelector('button[type="submit"]');
  const errorEl       = document.getElementById('loginError');

  const email    = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showError('Please enter your email and password.', errorEl);
    return;
  }

  // Loading state
  submitBtn.disabled = true;
  const originalHTML = submitBtn.innerHTML;
  submitBtn.innerHTML = `<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="40" stroke-dashoffset="10"/></svg> Signing in…`;

  try {
    const res  = await fetch(`${API_BASE}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.message || 'Login failed.');

    localStorage.setItem('trackit_token', data.token);
    localStorage.setItem('trackit_user',  JSON.stringify(data.user));
    // Clear tab preference on login so user starts on overview tab
    localStorage.removeItem('trackit_current_tab');

    redirectToDashboard(data.user.role);
  } catch (err) {
    showError(err.message, errorEl);
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalHTML;
  }
});

function showError(msg, el) {
  if (!el) {
    // Create error element if not present
    const form = document.getElementById('loginForm');
    let errEl  = document.getElementById('loginError');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.id = 'loginError';
      errEl.style.cssText = 'padding:12px 16px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:10px;color:#fca5a5;font-size:0.875rem;margin-top:8px;';
      form.appendChild(errEl);
    }
    errEl.textContent = msg;
    return;
  }
  el.textContent = msg;
  el.style.display = 'block';
}

function redirectToDashboard(role) {
  const map = {
    student:     'ojtdashboard.html',
    coordinator: 'coordinator-dashboard.html',
    supervisor:  'supervisor-dashboard.html'
  };
  window.location.href = map[role] || 'landingpage.html';
}