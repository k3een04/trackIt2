/**
 * Outbound email for TrackIT.
 *
 * The school issues Microsoft 365 (Outlook) mailboxes, so mail is sent through
 * Microsoft Graph `sendMail` with an app-only (client credentials) token. That
 * keeps the project dependency-free (Node's built-in fetch) and works in the
 * Vercel serverless runtime.
 *
 * Environment variables (backend/.env):
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
 * When the variables above are missing, isConfigured() is false and callers
 * fall back to logging the message on the server console, so the
 * password-reset flow can still be exercised in development.
 */

let cachedToken = null; // { value, expiresAt }

function getConfig() {
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

function isConfigured() {
  return getConfig().configured;
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
 * Send an email. Returns { delivered: false, reason: 'not-configured' } when the
 * Graph credentials are absent, and throws when Graph rejects the request.
 */
async function sendMail({ to, subject, text, html }) {
  const config = getConfig();

  if (!config.configured) {
    return { delivered: false, reason: 'not-configured' };
  }

  const accessToken = await getAccessToken(config);
  const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.senderEmail)}/sendMail`;

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
        toRecipients: [{ emailAddress: { address: to, name: config.senderName } }],
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

  return { delivered: true };
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
  sendMail,
  escapeHtml,
};
