// Outgoing email. One of these, set as Pages environment variables (secrets marked *):
//   Gmail or any SMTP server:  SMTP_USER, SMTP_PASS*, optional SMTP_HOST (smtp.gmail.com), SMTP_PORT (465 or 587)
//   Resend:                    RESEND_API_KEY*, MAIL_FROM (an address on a domain verified in Resend)
//   Brevo:                     BREVO_API_KEY*, MAIL_FROM (a sender verified in Brevo)
// Optional: MAIL_FROM ("Novulon <you@example.com>"), MAIL_NAME (display name, default "Novulon").
// Local testing: MAIL_DEV=1 prints the email to the console instead of sending it.

export class MailNotReady extends Error {}

export function mailReady(env) {
  return !!(env.RESEND_API_KEY || env.BREVO_API_KEY || (env.SMTP_USER && env.SMTP_PASS) || env.MAIL_DEV === '1');
}

function fromParts(env) {
  const name = env.MAIL_NAME || 'Novulon';
  const raw = env.MAIL_FROM || env.SMTP_USER || '';
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || name, email: m[2] };
  return { name, email: raw.trim() };
}

export async function sendMail(env, msg) {
  if (env.RESEND_API_KEY) return resend(env, msg);
  if (env.BREVO_API_KEY) return brevo(env, msg);
  if (env.SMTP_USER && env.SMTP_PASS) return smtp(env, msg);
  if (env.MAIL_DEV === '1') {
    console.log(`\n[mail] to ${msg.to}: ${msg.subject}\n${msg.text}\n`);
    return { dev: true };
  }
  throw new MailNotReady('Email is not set up yet.');
}

async function resend(env, msg) {
  const from = fromParts(env);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${from.name} <${from.email}>`, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

async function brevo(env, msg) {
  const from = fromParts(env);
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: from, to: [{ email: msg.to }], subject: msg.subject, htmlContent: msg.html, textContent: msg.text }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// ---- a small SMTP client over Cloudflare's TCP sockets (port 465 TLS, or 587 STARTTLS) --------------------

function b64utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function wrap76(s) { return s.replace(/.{1,76}/g, '$&\r\n'); }
function header(text) { return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64utf8(text)}?=`; }

function mime(from, msg) {
  const boundary = 'nv' + crypto.randomUUID().replace(/-/g, '');
  const domain = from.email.split('@')[1] || 'novulon.local';
  return [
    `From: ${header(from.name)} <${from.email}>`,
    `To: <${msg.to}>`,
    `Subject: ${header(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64utf8(msg.text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64utf8(msg.html)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function smtp(env, msg) {
  const { connect } = await import('cloudflare:sockets');
  const host = env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(env.SMTP_PORT || 465);
  const from = fromParts(env);
  const enc = new TextEncoder(), dec = new TextDecoder();

  let socket = connect({ hostname: host, port }, { secureTransport: port === 465 ? 'on' : 'starttls', allowHalfOpen: false });
  let reader = socket.readable.getReader(), writer = socket.writable.getWriter();
  let buf = '';

  async function reply() {
    for (;;) {
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
          buf = lines.slice(i + 1).join('\r\n');
          return { code: Number(lines[i].slice(0, 3)), text: lines.slice(0, i + 1).join(' | ') };
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP connection closed');
      buf += dec.decode(value, { stream: true });
    }
  }
  async function send(line, ok, secret) {
    await writer.write(enc.encode(line + '\r\n'));
    const r = await reply();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${secret ? '(auth)' : line.split(' ')[0]} -> ${r.code} ${r.text.slice(0, 200)}`);
    return r;
  }

  const timer = setTimeout(() => { try { socket.close(); } catch (e) { /* closed */ } }, 20000);
  try {
    let r = await reply();
    if (r.code !== 220) throw new Error(`SMTP greeting ${r.code}`);
    await send('EHLO novulon.pages.dev', [250]);
    if (port !== 465) {
      await send('STARTTLS', [220]);
      reader.releaseLock(); writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader(); writer = socket.writable.getWriter();
      await send('EHLO novulon.pages.dev', [250]);
    }
    await send('AUTH LOGIN', [334]);
    await send(b64utf8(env.SMTP_USER), [334], true);
    await send(b64utf8(env.SMTP_PASS), [235], true);
    await send(`MAIL FROM:<${from.email}>`, [250]);
    await send(`RCPT TO:<${msg.to}>`, [250, 251]);
    await send('DATA', [354]);
    const body = mime(from, msg).replace(/\r\n\./g, '\r\n..');
    await send(body + '\r\n.', [250]);
    try { await writer.write(enc.encode('QUIT\r\n')); } catch (e) { /* closing anyway */ }
  } finally {
    clearTimeout(timer);
    try { socket.close(); } catch (e) { /* closed */ }
  }
}

// ---- the two emails -----------------------------------------------------------------------------------------

function layout(title, intro, button, link, foot) {
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f1f8;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1d1726">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1f8;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e6e0ee">
<tr><td style="height:5px;background:linear-gradient(100deg,#ff4f9a,#a855f7)"></td></tr>
<tr><td style="padding:30px 32px 8px"><div style="font:800 13px/1 Segoe UI,Arial,sans-serif;letter-spacing:.2em;color:#a855f7">NOVULON</div>
<h1 style="margin:14px 0 10px;font:800 24px/1.2 Segoe UI,Arial,sans-serif;color:#1d1726">${title}</h1>
<p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#4a4257">${intro}</p>
<a href="${link}" style="display:inline-block;padding:13px 24px;border-radius:999px;background:#c04fe0;background:linear-gradient(100deg,#ff4f9a,#a855f7);color:#ffffff;font-weight:700;font-size:15px;text-decoration:none">${button}</a>
<p style="margin:24px 0 6px;font-size:12.5px;line-height:1.5;color:#7a718a">Or copy this link:</p>
<p style="margin:0 0 22px;font-size:12.5px;line-height:1.5;word-break:break-all"><a href="${link}" style="color:#a855f7">${link}</a></p>
<p style="margin:0 0 28px;font-size:12.5px;line-height:1.5;color:#7a718a">${foot}</p></td></tr></table>
</td></tr></table></body></html>`;
  return html;
}

export function verifyEmail(username, link) {
  return {
    subject: 'Confirm your email for the Novulon forum',
    text: `Hi ${username},\n\nConfirm this email for your Novulon account:\n${link}\n\nThe link expires in 24 hours. If this wasn't you, ignore this email.`,
    html: layout('Confirm your email', `Hi ${esc(username)}, confirm this email for your Novulon account.`,
      'Confirm email', link, 'The link expires in 24 hours. If this wasn\'t you, ignore this email.'),
  };
}

export function resetEmail(username, link) {
  return {
    subject: 'Reset your Novulon password',
    text: `Hi ${username},\n\nReset your Novulon password here:\n${link}\n\nThe link expires in 1 hour. If you didn't request this, ignore this email.`,
    html: layout('Reset your password', `Hi ${esc(username)}, use the button below to choose a new password.`,
      'Reset password', link, 'The link expires in 1 hour. If you didn\'t request this, ignore this email.'),
  };
}

export function emailTakenNotice(origin) {
  const link = `${origin}/account/forgot`;
  return {
    subject: 'Your email was entered on the Novulon forum',
    text: `Someone tried to add this email to a Novulon account, but it already belongs to another account.\n\nIf this was you, sign in to your existing account, or reset its password here:\n${link}\n\nIf it wasn't you, ignore this email. Nothing changed.`,
    html: layout('This email is already in use', 'Someone tried to add this email to a Novulon account, but it already belongs to another account. If this was you, sign in to your existing account or reset its password.',
      'Reset password', link, "If it wasn't you, ignore this email. Nothing changed."),
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
