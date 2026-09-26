/**
 * Development mail catcher + viewer for TrackIT.
 *
 * A dependency-free stand-in for Mailtrap: it speaks enough SMTP to accept the
 * password-reset mail nodemailer sends, and serves a small web inbox where you
 * can read the message (and the 6-digit code) that "went out".
 *
 * Run it (from the backend folder):
 *   npm run devmailbox
 *
 * Then point backend/.env at it - no credentials, no signup:
 *   MAIL_TRANSPORT=smtp
 *   SMTP_HOST=127.0.0.1
 *   SMTP_PORT=2525
 *   SMTP_FROM=no-reply@wnu.sti.edu.ph
 *   SMTP_REQUIRE_TLS=false
 *   # leave SMTP_USER / SMTP_PASS empty
 *
 * SMTP listens on DEV_MAIL_SMTP_PORT (default 2525) and the inbox web page on
 * DEV_MAIL_WEB_PORT (default 2526). Messages are kept in memory (last 50) and
 * mirrored to dev-mailbox/messages.log so you can still inspect them later.
 *
 * This is a development tool only - it is never used unless SMTP_HOST/port are
 * pointed at it.
 */

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SMTP_PORT = Number(process.env.DEV_MAIL_SMTP_PORT) || 2525;
const WEB_PORT = Number(process.env.DEV_MAIL_WEB_PORT) || 2526;
const MAX_MESSAGES = 50;
const LOG_DIR = path.join(__dirname, '..', 'dev-mailbox');
const LOG_FILE = path.join(LOG_DIR, 'messages.log');

const messages = [];
let nextId = 1;

// ── MIME helpers ──────────────────────────────────────────────────────────
function decodeQuotedPrintable(input) {
  return String(input)
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodePartBody(body, encoding) {
  const value = String(body);
  const normalized = String(encoding || '7bit').toLowerCase();

  if (normalized === 'base64') {
    return Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (normalized === 'quoted-printable') {
    const decoded = decodeQuotedPrintable(value);
    return Buffer.from(decoded, 'binary').toString('utf8');
  }
  return value;
}

function parseHeaders(rawHeaders) {
  const headers = {};
  let currentKey = null;

  rawHeaders.split(/\r?\n/).forEach((line) => {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] += ' ' + line.trim();
      return;
    }

    const index = line.indexOf(':');
    if (index === -1) return;

    currentKey = line.slice(0, index).trim().toLowerCase();
    headers[currentKey] = line.slice(index + 1).trim();
  });

  return headers;
}

// Walk a (possibly multipart) MIME body and pull out the text/html parts
function collectParts(headers, body, collected = []) {
  const contentType = String(headers['content-type'] || '');
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);

  if (contentType.toLowerCase().startsWith('multipart/') && boundaryMatch) {
    const boundary = '--' + boundaryMatch[1];
    const segments = String(body).split(boundary);

    segments.forEach((segment) => {
      const cleaned = segment.replace(/^\r?\n/, '');
      const trimmed = cleaned.trim();

      // Skip empty segments, the closing "--" terminator and headerless chunks
      if (!trimmed || /^--\s*$/.test(trimmed) || !cleaned.includes(':')) {
        return;
      }

      const splitIndex = cleaned.search(/\r?\n\r?\n/);
      if (splitIndex === -1) return;

      const partHeaders = parseHeaders(cleaned.slice(0, splitIndex));
      const partBody = cleaned.slice(splitIndex).replace(/^\r?\n\r?\n/, '');
      collectParts(partHeaders, partBody, collected);
    });

    return collected;
  }

  collected.push({
    type: (contentType.split(';')[0] || 'text/plain').trim().toLowerCase(),
    charset: (contentType.match(/charset="?([^";]+)"?/i) || [])[1] || 'utf-8',
    content: decodePartBody(body, headers['content-transfer-encoding']),
  });

  return collected;
}

function parseMessage(raw) {
  const splitIndex = raw.search(/\r?\n\r?\n/);
  const headerBlock = splitIndex === -1 ? raw : raw.slice(0, splitIndex);
  let body = splitIndex === -1 ? '' : raw.slice(splitIndex).replace(/^\r?\n\r?\n/, '');

  const headers = parseHeaders(headerBlock);
  const parts = collectParts(headers, body);

  // multipart bodies keep the closing boundary in the last part
  const textPart = parts.find((part) => part.type === 'text/plain');
  const htmlPart = parts.find((part) => part.type === 'text/html');

  if (textPart) {
    textPart.content = textPart.content.replace(/\r?\n--[^\n]*$/, '').trim();
  }
  if (htmlPart) {
    htmlPart.content = htmlPart.content.replace(/\r?\n--[^\n]*$/, '').trim();
  }

  body = textPart ? textPart.content : body;

  const addressOf = (value) => String(value || '').replace(/.*<([^>]+)>.*/, '$1').trim();

  return {
    from: addressOf((headers.from || '').replace(/^"|"$/g, '')),
    fromHeader: headers.from || '',
    to: addressOf(headers.to || ''),
    subject: headers.subject || '(no subject)',
    date: headers.date ? new Date(headers.date) : new Date(),
    text: body,
    html: htmlPart ? htmlPart.content : '',
    raw,
  };
}

function store(raw) {
  const message = { id: nextId++, receivedAt: new Date(), ...parseMessage(raw) };
  messages.unshift(message);

  if (messages.length > MAX_MESSAGES) {
    messages.length = MAX_MESSAGES;
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `===== #${message.id} ${message.receivedAt.toISOString()} =====\n${raw}\n`);
  } catch (error) {
    console.warn('Could not write the message log:', error.message);
  }

  console.log(`\n[devmailbox] #${message.id} from ${message.from} to ${message.to}`);
  console.log(`[devmailbox] subject: ${message.subject}`);
  console.log(`[devmailbox] open http://localhost:${WEB_PORT} to read it\n`);

  return message;
}

// ── SMTP listener ─────────────────────────────────────────────────────────
function createSmtpServer() {
  return net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    let authStep = 'idle';

    socket.write('220 trackit devmailbox ESMTP ready\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      for (;;) {
        const index = buffer.indexOf('\r\n');
        if (index === -1) break;

        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            store(data);
            data = '';
            socket.write('250 2.0.0 Ok: queued\r\n');
            continue;
          }
          data += line.replace(/^\.\./, '.') + '\n';
          continue;
        }

        // Multi-step AUTH LOGIN / PLAIN handshake (credentials are ignored)
        if (authStep === 'login-user') {
          authStep = 'login-pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (authStep === 'login-pass' || authStep === 'plain') {
          authStep = 'idle';
          socket.write('235 2.7.0 Authentication successful\r\n');
          continue;
        }

        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-trackit-devmailbox\r\n250-8BITMIME\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 26214400\r\n');
        } else if (upper === 'AUTH LOGIN') {
          authStep = 'login-user';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          authStep = line.trim().split(/\s+/).length > 2 ? 'idle' : 'plain';
          socket.write(authStep === 'plain' ? '334 \r\n' : '235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('AUTH')) {
          authStep = 'plain';
          socket.write('334 \r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper.startsWith('DATA')) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper.startsWith('QUIT')) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else if (upper.startsWith('RSET')) {
          data = '';
          authStep = 'idle';
          socket.write('250 2.0.0 Ok\r\n');
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });

    socket.on('error', () => {});
  });
}

// ── Web inbox ─────────────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMessage(message) {
  const text = message.text || '(no text body)';
  const html = message.html || '';

  return `
  <article style="background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:20px;margin-bottom:18px;">
    <div style="font-size:16px;font-weight:700;color:#ffffff;margin-bottom:6px;">${escapeHtml(message.subject)}</div>
    <div style="font-size:12px;color:#94a3b8;margin-bottom:14px;">
      #${message.id} &middot; from <span style="color:#00c8aa;">${escapeHtml(message.from)}</span>
      &middot; to ${escapeHtml(message.to)} &middot; ${escapeHtml(message.receivedAt.toLocaleString())}
    </div>
    <pre style="background:#0a0f1e;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;color:#e2e8f0;font-size:13px;white-space:pre-wrap;word-break:break-word;margin:0 0 12px;">${escapeHtml(text)}</pre>
    ${html ? `<details><summary style="cursor:pointer;color:#00c8aa;font-size:13px;">Show the HTML version</summary>
      <iframe sandbox="" srcdoc="${escapeHtml(html)}" style="width:100%;height:420px;border:1px solid rgba(255,255,255,0.08);border-radius:10px;background:#ffffff;margin-top:10px;"></iframe>
    </details>` : ''}
    <div style="margin-top:12px;font-size:12px;"><a href="/raw/${message.id}" style="color:#00c8aa;">View raw message</a></div>
  </article>`;
}

function renderInbox() {
  const body = messages.length
    ? messages.map(renderMessage).join('')
    : '<p style="color:#94a3b8;">No messages yet. Trigger a password reset from the login page and it will show up here.</p>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<title>TrackIT dev mailbox (${messages.length})</title>
<meta http-equiv="refresh" content="10" />
</head>
<body style="background:#0a0f1e;color:#e2e8f0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:28px;">
  <div style="max-width:760px;margin:0 auto;">
    <div style="font-size:20px;font-weight:800;color:#ffffff;">Track<span style="color:#00c8aa;">IT</span> dev mailbox</div>
    <p style="font-size:13px;color:#94a3b8;margin:6px 0 20px;">
      Captured SMTP mail for local testing (auto-refreshes every 10s). The reset code is in the message below.
    </p>
    <form method="post" action="/clear" style="margin-bottom:20px;">
      <button type="submit" style="background:#00c8aa;color:#0a0f1e;border:none;border-radius:10px;padding:9px 16px;font-weight:700;cursor:pointer;">Clear inbox</button>
    </form>
    ${body}
  </div>
</body></html>`;
}

function createWebServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${WEB_PORT}`);

    if (url.pathname === '/api/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(messages.map(({ raw, html, ...rest }) => rest), null, 2));
      return;
    }

    const rawMatch = url.pathname.match(/^\/raw\/(\d+)$/);
    if (rawMatch) {
      const message = messages.find((item) => item.id === Number(rawMatch[1]));
      if (!message) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Message not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message.raw);
      return;
    }

    if (url.pathname === '/clear' && req.method === 'POST') {
      messages.length = 0;
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderInbox());
  });
}

createSmtpServer().listen(SMTP_PORT, '127.0.0.1', () => {
  console.log(`\n[devmailbox] SMTP ready on 127.0.0.1:${SMTP_PORT} (no auth, no TLS)`);
});

createWebServer().listen(WEB_PORT, '127.0.0.1', () => {
  console.log(`[devmailbox] inbox: http://localhost:${WEB_PORT}`);
  console.log('[devmailbox] point SMTP_HOST/SMTP_PORT at the port above and send a reset code\n');
});
