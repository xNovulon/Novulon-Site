// Passwords, sessions and one-time tokens.
// Passwords: PBKDF2-SHA256 with a random salt (100,000 rounds, the most the Workers runtime allows).
// Sessions and email tokens are random 32-byte values; only their SHA-256 hash is stored.

const ITERATIONS = 100000;
const SESSION_DAYS = 30;
export const COOKIE = 'nv_sid';

const enc = new TextEncoder();

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(str) {
  const s = atob(str), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(text) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}
function same(a, b) {
  if (a.length !== b.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return { pass_hash: b64(hash), pass_salt: b64(salt), pass_iter: ITERATIONS };
}

export async function checkPassword(user, password) {
  const hash = await derive(password, unb64(user.pass_salt), user.pass_iter);
  return same(hash, unb64(user.pass_hash));
}

// ---- sessions ---------------------------------------------------------------------------------------------

export async function startSession(db, userId) {
  const token = randomToken(), now = Date.now();
  await db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(await sha256(token), userId, now, now + SESSION_DAYS * 864e5).run();
  return token;
}

export function sessionCookie(token, secure) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}
export function clearCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function cookieToken(request) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

// The signed-in user for this request, or null.
export async function currentUser(db, request) {
  const token = cookieToken(request);
  if (!token || token.length > 100) return null;
  const hash = await sha256(token);
  const row = await db.prepare(
    `SELECT u.*, s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2`).bind(hash, Date.now()).first();
  return row || null;
}

export async function endSession(db, request) {
  const token = cookieToken(request);
  if (token) await db.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(await sha256(token)).run();
}

export async function endOtherSessions(db, userId, keepHash) {
  await db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2`).bind(userId, keepHash || '').run();
}

// ---- one-time tokens (email verification, password reset) -------------------------------------------------

export async function makeToken(db, userId, kind, hours) {
  const token = randomToken();
  await db.prepare(`UPDATE tokens SET used_at = ?3 WHERE user_id = ?1 AND kind = ?2 AND used_at IS NULL`)
    .bind(userId, kind, Date.now()).run();
  await db.prepare(`INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(await sha256(token), userId, kind, Date.now() + hours * 36e5).run();
  return token;
}

// Marks the token used and returns its user id, or null when it is unknown, used or expired.
export async function useToken(db, token, kind) {
  if (typeof token !== 'string' || !token || token.length > 100) return null;
  const row = await db.prepare(
    `UPDATE tokens SET used_at = ?3 WHERE token_hash = ?1 AND kind = ?2 AND used_at IS NULL AND expires_at > ?3
     RETURNING user_id`).bind(await sha256(token), kind, Date.now()).first();
  return row ? row.user_id : null;
}
