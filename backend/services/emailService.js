/**
 * Outbound email for TrackIT.
 *
 * Two transports are supported; the first one that is configured wins:
 *
 * 1. SMTP (`SMTP_*`) - sign in with a real mailbox (e.g. the school Microsoft
 *    365 account) and let nodemailer deliver the message. This is the quickest
 *    way to get codes into student inboxes.
 * 2. Microsoft Graph (`MS_*`) - app-only token, no mailbox password involved.
 *
 * SMTP environment variables (backend/.env):
 *   SMTP_HOST     - e.g. smtp.office365.com (or smtp.gmail.com)
 *   SMTP_PORT     - 587 for STARTTLS (465 with SMTP_SECURE=true)
 *   SMTP_SECURE   - 'true' for implicit TLS, default false
 *   SMTP_USER     - mailbox login, e.g. ojt-noreply@wnu.sti.edu.ph
 *   SMTP_PASS     - mailbox password / app password
 *   SMTP_FROM     - From address (defaults to SMTP_USER)
 *   SMTP_FROM_NAME- display name (defaults to TrackIT)
 *   SMTP_REQUIRE_TLS - default true on port 587
 *   SMTP_REJECT_UNAUTHORIZED - 'false' to accept a self-signed certificate
 *   MAIL_TRANSPORT- 'smtp' | 'graph' to force one, default 'auto'
 *
 * Microsoft 365 notes: the tenant must allow SMTP AUTH for that mailbox
 * (`Set-CASMailbox -Identity <mailbox> -SmtpClientAuthenticationDisabled $false`)
 * and, when MFA is enforced, an app password has to be used.
 *
 * Graph environment variables:
 *   MS_TENANT_ID     - Azure AD tenant id (or the *.onmicrosoft.com domain)
 *   MS_CLIENT_ID     - app registration (client) id
 *   MS_CLIENT_SECRET - app registration client secret
 *   MS_SENDER_EMAIL  - mailbox the mail is sent from, e.g. no-reply@wnu.sti.edu.ph
 *   MS_SENDER_NAME   - optional display name (defaults to TrackIT)
 *
 * Setup: register an app in Azure AD, give it the *application* permission
 * `Mail.Send` and grant admin consent. Because that permission covers every
 * mailbox in the tenant, scope it with an Application Access Policy:
 *
 *   New-ApplicationAccessPolicy -AppId <client id> `
 *     -PolicyScopeGroupId <mail-enabled security group> `
 *     -AccessRight RestrictAccess `
 *     -Description "TrackIT password reset mail"
 *
 * When neither transport is configured, isConfigured() is false and callers fall
 * back to logging the message on the server console, so the password-reset flow
 * can still be exercised in development.
 */

let nodemailer = null;
try {
  // Only needed for the SMTP transport
  nodemailer = require('nodemailer');
} catch (error) {
  nodemailer = null;
}

let cachedToken = null; // { value, expiresAt }

function getGraphConfig() {
  const tenantId = String(process.env.MS_TENANT_ID || '').trim();
  const clientId = String(process.env.MS_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.MS_CLIENT_SECRET || '').trim();
  const senderEmail = String(process.env.MS_SENDER_EMAIL || '').trim();
  const senderName = String(process.env.MS_SENDER_NAME || 'TrackIT').trim();

  return {
    tenantId,
    clientId,
    clientSecret,
    senderEmail,
    senderName,
    configured: Boolean(tenantId && clientId && clientSecret && senderEmail),
  };
}

function getSmtpConfig() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const fromAddress = String(process.env.SMTP_FROM || user).trim();
  const fromName = String(process.env.SMTP_FROM_NAME || 'TrackIT').trim();
  const requireTlsEnv = String(process.env.SMTP_REQUIRE_TLS || '').trim().toLowerCase();

  return {
    host,
    port,
    secure,
    user,
    pass,
    fromAddress,
    fromName,
    // STARTTLS is required by Microsoft 365 / Gmail on port 587
    requireTLS: requireTlsEnv ? requireTlsEnv === 'true' : (!secure && port === 587),
    rejectUnauthorized: String(process.env.SMTP_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false',
    configured: Boolean(host && fromAddress),
  };
}

function getConfig() {
  const graph = getGraphConfig();
  const smtp = getSmtpConfig();
  const preference = String(process.env.MAIL_TRANSPORT || 'auto').trim().toLowerCase();

  let transport = 'none';
  if (preference === 'smtp') {
    transport = smtp.configured ? 'smtp' : 'none';
  } else if (preference === 'graph') {
    transport = graph.configured ? 'graph' : 'none';
  } else {
    transport = smtp.configured ? 'smtp' : (graph.configured ? 'graph' : 'none');
  }

  return { graph, smtp, preference, transport, configured: transport !== 'none' };
}

function isConfigured() {
  return getConfig().configured;
}

// Small summary used in logs / diagnostics (never includes the password)
function describeTransport() {
  const config = getConfig();

  if (config.transport === 'smtp') {
    return {
      transport: 'smtp',
      sender: config.smtp.fromAddress,
      server: `${config.smtp.host}:${config.smtp.port}`,
      auth: Boolean(config.smtp.user),
    };
  }

  if (config.transport === 'graph') {
    return { transport: 'graph', sender: config.graph.senderEmail };
  }

  return { transport: 'none', sender: null };
}

// App-only token for Graph, cached until shortly before it expires
async function getAccessToken(config) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60000 > now) {
    return cachedToken.value;
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Microsoft Graph token request failed (${response.status}): ` +
      `${data.error_description || data.error || 'unknown error'}`,
    );
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
  };

  return cachedToken.value;
}

/**
 * Send an email through whichever transport is configured.
 * Returns { delivered: false, reason: 'not-configured' } when there is none, and
 * throws when the transport rejects the message.
 */
async function sendMail({ to, subject, text, html }) {
  const config = getConfig();

  if (!config.configured) {
    return { delivered: false, reason: 'not-configured' };
  }

  if (config.transport === 'smtp') {
    await sendViaSmtp(config.smtp, { to, subject, text, html });
    return { delivered: true, transport: 'smtp' };
  }

  await sendViaGraph(config.graph, { to, subject, text, html });
  return { delivered: true, transport: 'graph' };
}

// SMTP delivery through nodemailer (school Microsoft 365 mailbox, Gmail, ...)
async function sendViaSmtp(smtp, { to, subject, text, html }) {
  if (!nodemailer) {
    throw new Error(
      'SMTP is configured but the nodemailer package is missing. Run "npm install" in the backend folder.',
    );
  }

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: smtp.requireTLS,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    tls: { rejectUnauthorized: smtp.rejectUnauthorized },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });

  try {
    await transport.sendMail({
      from: `"${smtp.fromName}" <${smtp.fromAddress}>`,
      to,
      subject,
      text,
      html,
    });
  } finally {
    transport.close();
  }
}

// App-only Microsoft Graph sendMail (no mailbox password involved)
async function sendViaGraph(graph, { to, subject, text, html }) {
  const accessToken = await getAccessToken(graph);
  const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(graph.senderEmail)}/sendMail`;

  const response = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: {
          contentType: html ? 'HTML' : 'Text',
          content: html || text || '',
        },
        toRecipients: [{ emailAddress: { address: to, name: graph.senderName } }],
      },
      saveToSentItems: true,
    }),
  });

  // Graph answers 202 Accepted on success and a JSON error body otherwise
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(
      `Microsoft Graph sendMail failed (${response.status}): ` +
      `${detail?.error?.message || 'unknown error'}`,
    );
  }
}

// Minimal HTML escaping for values dropped into an email template
function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  getConfig,
  isConfigured,
  describeTransport,
  sendMail,
  escapeHtml,
};
