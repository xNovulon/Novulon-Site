// The forum API behind /api/*: accounts, threads and replies. Text only, no images.
// Accounts need a name and password. An email is optional, used only for password resets, and never sent to anyone
// but its owner: no public response contains an email address.
import { ensureSchema, allow } from './db.js';
import {
  hashPassword, checkPassword, burnPasswordCheck, startSession, sessionCookie, clearCookie, currentUser, endSession,
  endOtherSessions, makeToken, useToken, sameSecret,
} from './auth.js';
import { sendMail, mailReady, verifyEmail, resetEmail, emailTakenNotice, MailNotReady } from './mail.js';

export const GAMES = { sims: 'The Sims 4', inzoi: 'inZOI' };
const SORTS = { activity: 't.last_post_at DESC', new: 't.created_at DESC', replies: 't.reply_count DESC, t.last_post_at DESC',
  views: 't.view_count DESC, t.last_post_at DESC' };
// own keys only, so names like __proto__ or constructor never count as a game or a sort
function own(map, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key); }
const SITE = 'https://novulon.pages.dev';
const THREADS_PER_PAGE = 20;
const REPLIES_PER_PAGE = 25;
const COMMON_PASSWORDS = new Set(('password password1 password12 password123 passw0rd 12345678 123456789 1234567890 11111111 00000000 '
  + '87654321 12341234 qwerty123 qwertyuiop 1q2w3e4r 1qaz2wsx zaq12wsx asdfghjk abc12345 abcd1234 iloveyou admin123 '
  + 'letmein1 welcome1 sunshine princess football baseball superman starwars dragon12 monkey123 trustno1 whatever '
  + 'thesims4 simsims4 inzoi123 novulon novulon1 novulon123').split(' '));

class HttpError extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
function fail(status, message, code, extra) { throw new HttpError(status, message, code || 'error', extra); }

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Cross-Origin-Resource-Policy': 'same-origin', ...headers,
    },
  });
}

// ---- helpers -------------------------------------------------------------------------------------------------

function clean(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}
function oneLine(text) { return clean(text).replace(/\s+/g, ' '); }
function noImages(text) {
  if (/<\s*img\b|\[img\b|!\[[^\]]*\]\(|data:image\//i.test(text)) fail(400, "Images aren't allowed.", 'images');
}
function isAdmin(user) { return !!user && user.role === 'admin'; }
function publicUser(u) {
  return { name: u.username, joined: u.created_at, posts: u.post_count, admin: isAdmin(u) };
}
function pageOf(value, pages) {
  if (value === 'last') return pages;
  const n = Math.floor(Number(value) || 1);
  return Math.min(Math.max(1, n), Math.max(1, pages));
}

// Names that only the owner can take: Novulon and staff words, including lookalikes such as N0vulon or Novu1on_.
function reservedName(name) {
  const base = name.toLowerCase().replace(/[._-]/g, '').replace(/0/g, 'o').replace(/3/g, 'e').replace(/4/g, 'a')
    .replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b').replace(/\$/g, 's');
  for (const v of [base.replace(/1/g, 'l'), base.replace(/1/g, 'i'), base.replace(/[1l]/g, 'i')]) {
    if (/novu[li]on|n[o0]vul[o0]n|admin|moderator|m[o0]derat/.test(v)) return true;
    if (/^(mod|mods|staff|system|support|official|root|owner|forum|team)$/.test(v)) return true;
  }
  return false;
}
function checkUsername(name) {
  if (typeof name !== 'string') fail(400, 'Pick a name.', 'username');
  name = name.trim();
  if (name.length < 3 || name.length > 20) fail(400, 'Names are 3 to 20 characters.', 'username');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*[A-Za-z0-9_]$/.test(name) || /[.-]{2}/.test(name)) {
    fail(400, 'Names can use letters, numbers, dots, dashes and underscores.', 'username');
  }
  return name;
}
function checkEmail(email) {
  if (typeof email !== 'string') fail(400, 'Enter an email.', 'email');
  email = email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>"',;:\\]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) fail(400, 'Enter a valid email.', 'email');
  return email;
}
function checkPasswordRules(password, name, email) {
  if (typeof password !== 'string' || password.length < 8) fail(400, 'Password must be at least 8 characters.', 'password');
  if (password.length > 200) fail(400, 'Password is too long.', 'password');
  const low = password.toLowerCase();
  if ((name && low.includes(name.toLowerCase())) || (email && low === email)) fail(400, "Password can't contain your name or email.", 'password');
  if (COMMON_PASSWORDS.has(low) || /^(.)\1+$/.test(password)) fail(400, 'That password is too easy to guess.', 'password');
  return password;
}
async function turnstile(ctx, token) {
  const secret = ctx.env.TURNSTILE_SECRET;
  if (!secret) return;
  if (!token) fail(400, 'Complete the check.', 'captcha');
  const form = new FormData();
  form.append('secret', secret); form.append('response', String(token)); form.append('remoteip', ctx.ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await r.json().catch(() => ({}));
  if (!out.success) fail(400, 'Check failed. Try again.', 'captcha');
}
async function limit(ctx, key, max, windowSec, message) {
  if (!(await allow(ctx.db, key, max, windowSec))) fail(429, message || 'Too many requests. Try again shortly.', 'rate');
}
function isLocal(url) { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname); }
// Links in emails never come from the request's Host header: the real site, or the local test server.
function siteOrigin(ctx) {
  if (ctx.env.SITE_URL) return ctx.env.SITE_URL.replace(/\/+$/, '');
  return isLocal(ctx.url) ? ctx.url.origin : SITE;
}
// Hosts this API answers changes for: the site, its preview builds, and the local test server.
function trustedHost(env, url) {
  if (isLocal(url)) return true;
  const h = url.hostname.toLowerCase();
  if (h === 'novulon.pages.dev' || h.endsWith('.novulon.pages.dev')) return true;
  try { return !!env.SITE_URL && new URL(env.SITE_URL).hostname.toLowerCase() === h; } catch (e) { return false; }
}
// Links are only echoed back on the local test server, never on the live site.
function devExtra(ctx, link) {
  return ctx.env.MAIL_DEV === '1' && isLocal(ctx.url) && link ? { devLink: link } : {};
}

// Sends in the background, so a response takes the same time whether or not an email went out.
function mailLater(ctx, to, message) {
  const job = sendMail(ctx.env, { to, ...message }).catch((e) => {
    if (!(e instanceof MailNotReady)) console.error('mail failed', e && e.message);
  });
  if (ctx.waitUntil) ctx.waitUntil(job);
  return job;
}

// Starts confirming an address for a user. If another account already owns it, that mailbox gets a notice instead
// of a link, and the reply looks the same either way.
async function beginEmail(ctx, user, email) {
  await ctx.db.prepare(`UPDATE users SET email_pending = ?2 WHERE id = ?1`).bind(user.id, email).run();
  const owner = await ctx.db.prepare(`SELECT id FROM users WHERE email = ?1`).bind(email).first();
  // a token is made either way (same work, same timing); for a taken address it can never be used, since
  // confirming checks the owner again
  const token = await makeToken(ctx.db, user.id, 'email', 24, email);
  if (owner && owner.id !== user.id) {
    mailLater(ctx, email, emailTakenNotice(siteOrigin(ctx)));
    return {};
  }
  const link = `${siteOrigin(ctx)}/account/verify?token=${token}`;
  mailLater(ctx, email, verifyEmail(user.username, link));
  return devExtra(ctx, link);
}

async function requireUser(ctx) {
  const user = await ctx.user();
  if (!user) fail(401, 'Sign in first.', 'auth');
  if (user.banned) fail(403, 'This account is blocked from posting.', 'banned');
  return user;
}
async function passwordGate(ctx, user, password) {
  await limit(ctx, 'pwcheck:' + user.id, 10, 900, 'Too many attempts. Try again in 15 minutes.');
  if (typeof password !== 'string' || !(await checkPassword(user, password))) fail(400, 'Password is wrong.', 'current');
}

// ---- accounts ------------------------------------------------------------------------------------------------

async function config(ctx) {
  return json({ games: GAMES, turnstile: ctx.env.TURNSTILE_SITE_KEY || null, mail: mailReady(ctx.env) });
}

async function me(ctx) {
  const u = await ctx.user();
  if (!u) return json({ user: null });
  return json({ user: { ...publicUser(u), email: u.email || null, emailPending: u.email_pending && u.email_pending !== u.email ? u.email_pending : null } });
}

async function register(ctx) {
  const b = await ctx.body();
  if (b.website) fail(400, 'Something went wrong. Try again.', 'bot');       // hidden field only bots fill in
  await limit(ctx, 'reg-try:' + ctx.ip, 30, 3600, 'Too many sign-ups. Try again later.');
  const username = checkUsername(b.username);
  const email = b.email ? checkEmail(b.email) : null;
  const password = checkPasswordRules(b.password, username, email);

  let role = 'member';
  if (reservedName(username)) {
    if (!b.owner_code) fail(400, 'That name is reserved.', 'reserved');
    await limit(ctx, 'claim:' + ctx.ip, 5, 3600, 'Too many attempts. Try again later.');
    if (!ctx.env.OWNER_CODE || !(await sameSecret(String(b.owner_code), ctx.env.OWNER_CODE))) fail(400, 'Wrong owner code.', 'reserved');
    role = 'admin';
  }
  await turnstile(ctx, b.turnstile);

  const taken = await ctx.db.prepare(`SELECT 1 FROM users WHERE username_key = ?1`).bind(username.toLowerCase()).first();
  if (taken) fail(409, 'That name is taken.', 'username');
  await limit(ctx, 'reg:' + ctx.ip, 6, 3600, 'Too many sign-ups. Try again later.');

  const pass = await hashPassword(password);
  const user = await ctx.db.prepare(
    `INSERT INTO users (username, username_key, pass_hash, pass_salt, pass_iter, role, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *`)
    .bind(username, username.toLowerCase(), pass.pass_hash, pass.pass_salt, pass.pass_iter, role, Date.now()).first();
  const extra = email ? await beginEmail(ctx, user, email) : {};
  const session = await startSession(ctx.db, user.id);
  return json({ ok: true, user: publicUser(user), emailSent: !!email, ...extra }, 201, { 'Set-Cookie': sessionCookie(session, ctx.secure) });
}

async function verifyEmailRoute(ctx) {
  const b = await ctx.body();
  await limit(ctx, 'verify:' + ctx.ip, 30, 3600);
  const tok = await useToken(ctx.db, b.token, 'email');
  if (!tok) fail(400, 'This link has expired.', 'token');
  const u = await ctx.db.prepare(`SELECT * FROM users WHERE id = ?1`).bind(tok.user_id).first();
  if (!u || u.email_pending !== tok.data) fail(400, 'This link has expired.', 'token');
  const owner = await ctx.db.prepare(`SELECT id FROM users WHERE email = ?1`).bind(tok.data).first();
  if (owner && owner.id !== u.id) fail(400, 'This link has expired.', 'token');
  await ctx.db.prepare(`UPDATE users SET email = ?2, email_pending = NULL WHERE id = ?1`).bind(u.id, tok.data).run();
  return json({ ok: true });
}

async function login(ctx) {
  const b = await ctx.body();
  const who = String(b.login || '').trim().toLowerCase().slice(0, 254);
  if (!who || typeof b.password !== 'string' || !b.password) fail(400, 'Enter your name and password.', 'login');
  await limit(ctx, 'login-ip:' + ctx.ip, 30, 900, 'Too many attempts. Try again in 15 minutes.');
  await limit(ctx, 'login:' + who, 10, 900, 'Too many attempts. Try again in 15 minutes.');
  const u = await ctx.db.prepare(who.includes('@') ? `SELECT * FROM users WHERE email = ?1` : `SELECT * FROM users WHERE username_key = ?1`)
    .bind(who).first();
  // a missing account costs the same time as a wrong password, so timing gives nothing away
  const ok = u ? await checkPassword(u, b.password) : (await burnPasswordCheck(b.password), false);
  if (!ok) fail(401, 'Wrong name or password.', 'login');
  if (u.banned) fail(403, 'This account is blocked.', 'banned');
  const session = await startSession(ctx.db, u.id);
  return json({ ok: true, user: publicUser(u) }, 200, { 'Set-Cookie': sessionCookie(session, ctx.secure) });
}

async function logout(ctx) {
  await endSession(ctx.db, ctx.request, ctx.secure);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(ctx.secure) });
}

async function forgot(ctx) {
  const b = await ctx.body();
  const email = checkEmail(b.email);
  await limit(ctx, 'forgot-ip:' + ctx.ip, 10, 3600);
  await limit(ctx, 'forgot:' + email, 3, 3600, 'Too many emails sent. Try again later.');
  const u = await ctx.db.prepare(`SELECT * FROM users WHERE email = ?1`).bind(email).first();
  let extra = {};
  if (u && !u.banned) {
    const token = await makeToken(ctx.db, u.id, 'reset', 1, null);
    const link = `${siteOrigin(ctx)}/account/reset?token=${token}`;
    mailLater(ctx, email, resetEmail(u.username, link));
    extra = devExtra(ctx, link);
  }
  return json({ ok: true, ...extra });
}

async function reset(ctx) {
  const b = await ctx.body();
  await limit(ctx, 'reset:' + ctx.ip, 20, 3600);
  const tok = await useToken(ctx.db, b.token, 'reset');
  if (!tok) fail(400, 'This link has expired.', 'token');
  const u = await ctx.db.prepare(`SELECT * FROM users WHERE id = ?1`).bind(tok.user_id).first();
  if (!u) fail(400, 'This link has expired.', 'token');
  const password = checkPasswordRules(b.password, u.username, u.email);
  const pass = await hashPassword(password);
  await ctx.db.prepare(`UPDATE users SET pass_hash = ?2, pass_salt = ?3, pass_iter = ?4 WHERE id = ?1`)
    .bind(u.id, pass.pass_hash, pass.pass_salt, pass.pass_iter).run();
  await endOtherSessions(ctx.db, u.id, '');
  const session = await startSession(ctx.db, u.id);
  return json({ ok: true, user: publicUser(u) }, 200, { 'Set-Cookie': sessionCookie(session, ctx.secure) });
}

async function changePassword(ctx) {
  const u = await requireUser(ctx);
  const b = await ctx.body();
  await passwordGate(ctx, u, b.current);
  const password = checkPasswordRules(b.password, u.username, u.email);
  const pass = await hashPassword(password);
  await ctx.db.prepare(`UPDATE users SET pass_hash = ?2, pass_salt = ?3, pass_iter = ?4 WHERE id = ?1`)
    .bind(u.id, pass.pass_hash, pass.pass_salt, pass.pass_iter).run();
  await endOtherSessions(ctx.db, u.id, u.session_hash);
  return json({ ok: true });
}

async function setEmail(ctx) {
  const u = await requireUser(ctx);
  const b = await ctx.body();
  const email = checkEmail(b.email);
  await passwordGate(ctx, u, b.password);
  if (email === u.email) fail(400, 'That is already your email.', 'email');
  await limit(ctx, 'email-set:' + u.id, 5, 3600, 'Too many emails sent. Try again later.');
  const extra = await beginEmail(ctx, u, email);
  return json({ ok: true, ...extra });
}

async function resendEmail(ctx) {
  const u = await requireUser(ctx);
  if (!u.email_pending || u.email_pending === u.email) fail(400, 'Nothing to confirm.', 'email');
  await limit(ctx, 'email-set:' + u.id, 5, 3600, 'Too many emails sent. Try again later.');
  const extra = await beginEmail(ctx, u, u.email_pending);
  return json({ ok: true, ...extra });
}

async function removeEmail(ctx) {
  const u = await requireUser(ctx);
  const b = await ctx.body();
  await passwordGate(ctx, u, b.password);
  await ctx.db.prepare(`UPDATE users SET email = NULL, email_pending = NULL WHERE id = ?1`).bind(u.id).run();
  await ctx.db.prepare(`UPDATE tokens SET used_at = ?2 WHERE user_id = ?1 AND used_at IS NULL`).bind(u.id, Date.now()).run();
  return json({ ok: true });
}

// ---- threads -------------------------------------------------------------------------------------------------

async function listThreads(ctx) {
  const q = ctx.url.searchParams;
  const game = own(GAMES, q.get('game')) ? q.get('game') : null;
  const sort = own(SORTS, q.get('sort')) ? SORTS[q.get('sort')] : SORTS.activity;
  const search = oneLine(q.get('q') || '').slice(0, 80);
  const where = ['t.deleted = 0'], args = [];
  if (game) { args.push(game); where.push(`t.game = ?${args.length}`); }
  if (search) {
    args.push('%' + search.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    where.push(`(t.title LIKE ?${args.length} ESCAPE '\\' OR t.body LIKE ?${args.length} ESCAPE '\\')`);
  }
  const whereSql = where.join(' AND ');
  const total = (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM threads t WHERE ${whereSql}`).bind(...args).first()).n;
  const pages = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const page = pageOf(q.get('page'), pages);
  const rows = await ctx.db.prepare(
    `SELECT t.id, t.game, t.title, substr(t.body, 1, 240) AS excerpt, t.created_at, t.last_post_at, t.reply_count,
            t.view_count, t.pinned, t.locked, u.username AS author, lu.username AS last_author
     FROM threads t JOIN users u ON u.id = t.user_id LEFT JOIN users lu ON lu.id = t.last_user_id
     WHERE ${whereSql} ORDER BY t.pinned DESC, ${sort}
     LIMIT ${THREADS_PER_PAGE} OFFSET ${(page - 1) * THREADS_PER_PAGE}`).bind(...args).all();
  const counts = { all: 0 };
  for (const key of Object.keys(GAMES)) counts[key] = 0;
  const byGame = await ctx.db.prepare(`SELECT game, COUNT(*) AS n FROM threads WHERE deleted = 0 GROUP BY game`).all();
  for (const r of byGame.results) { counts[r.game] = r.n; counts.all += r.n; }
  const threads = rows.results.map((t) => ({ ...t, pinned: !!t.pinned, locked: !!t.locked, excerpt: oneLine(t.excerpt).slice(0, 200) }));
  return json({ threads, page, pages, total, counts });
}

async function createThread(ctx) {
  const u = await requireUser(ctx);
  const b = await ctx.body();
  const game = own(GAMES, b.game) ? b.game : fail(400, 'Pick a game.', 'game');
  const title = oneLine(b.title);
  const body = clean(b.body);
  if (title.length < 4) fail(400, 'Title is too short.', 'title');
  if (title.length > 120) fail(400, 'Title is too long.', 'title');
  if (body.length < 10) fail(400, 'Description is too short.', 'body');
  if (body.length > 20000) fail(400, 'Description is too long.', 'body');
  noImages(title); noImages(body);
  await limit(ctx, 'thread:' + u.id, 1, 60, 'Wait a minute before starting another thread.');
  await limit(ctx, 'thread-day:' + u.id, 15, 86400, 'Daily thread limit reached.');
  const now = Date.now();
  const row = await ctx.db.prepare(
    `INSERT INTO threads (game, title, body, user_id, created_at, last_post_at, last_user_id) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?4) RETURNING id`)
    .bind(game, title, body, u.id, now).first();
  await ctx.db.prepare(`UPDATE users SET post_count = post_count + 1 WHERE id = ?1`).bind(u.id).run();
  return json({ ok: true, id: row.id }, 201);
}

async function loadThread(ctx, id) {
  const t = await ctx.db.prepare(
    `SELECT t.*, u.username, u.created_at AS joined, u.post_count, u.role
     FROM threads t JOIN users u ON u.id = t.user_id WHERE t.id = ?1 AND t.deleted = 0`).bind(id).first();
  if (!t) fail(404, 'Thread not found.', 'missing');
  return t;
}

async function getThread(ctx) {
  const id = Number(ctx.params[0]);
  const t = await loadThread(ctx, id);
  const user = await ctx.user();
  const admin = isAdmin(user);
  const pages = Math.max(1, Math.ceil(t.reply_count / REPLIES_PER_PAGE));
  const page = pageOf(ctx.url.searchParams.get('page'), pages);
  const rows = await ctx.db.prepare(
    `SELECT r.id, r.body, r.created_at, r.edited_at, r.user_id, u.username, u.created_at AS joined, u.post_count, u.role
     FROM replies r JOIN users u ON u.id = r.user_id WHERE r.thread_id = ?1 AND r.deleted = 0 ORDER BY r.id
     LIMIT ${REPLIES_PER_PAGE} OFFSET ${(page - 1) * REPLIES_PER_PAGE}`).bind(id).all();
  if (await allow(ctx.db, `view:${ctx.ip}:${id}`, 1, 1800)) {
    await ctx.db.prepare(`UPDATE threads SET view_count = view_count + 1 WHERE id = ?1`).bind(id).run();
    t.view_count += 1;
  }
  const author = (row) => ({ name: row.username, joined: row.joined, posts: row.post_count, admin: row.role === 'admin' });
  const canPost = !!(user && !user.banned && (!t.locked || admin));
  return json({
    thread: {
      id: t.id, game: t.game, title: t.title, body: t.body, created_at: t.created_at, edited_at: t.edited_at,
      reply_count: t.reply_count, view_count: t.view_count, pinned: !!t.pinned, locked: !!t.locked,
      author: author(t), mine: !!(user && user.id === t.user_id),
    },
    replies: rows.results.map((r, i) => ({
      id: r.id, n: (page - 1) * REPLIES_PER_PAGE + i + 2, body: r.body, created_at: r.created_at, edited_at: r.edited_at,
      author: author(r), mine: !!(user && user.id === r.user_id),
    })),
    page, pages,
    can: { reply: canPost, moderate: admin, deleteThread: admin || !!(user && user.id === t.user_id && t.reply_count === 0) },
    me: user ? { name: user.username } : null,
  });
}

async function editThread(ctx) {
  const u = await requireUser(ctx);
  const t = await loadThread(ctx, Number(ctx.params[0]));
  if (t.user_id !== u.id && !isAdmin(u)) fail(403, "You can't edit this thread.", 'owner');
  const b = await ctx.body();
  const game = b.game === undefined ? t.game : (own(GAMES, b.game) ? b.game : fail(400, 'Pick a game.', 'game'));
  const title = b.title === undefined || b.title === null ? t.title : oneLine(b.title);
  const body = b.body === undefined ? t.body : clean(b.body);
  if (title.length < 4 || title.length > 120) fail(400, 'Titles are 4 to 120 characters.', 'title');
  if (body.length < 10 || body.length > 20000) fail(400, 'Descriptions are 10 to 20,000 characters.', 'body');
  noImages(title); noImages(body);
  await limit(ctx, 'edit:' + u.id, 30, 3600);
  await ctx.db.prepare(`UPDATE threads SET game = ?2, title = ?3, body = ?4, edited_at = ?5 WHERE id = ?1`)
    .bind(t.id, game, title, body, Date.now()).run();
  return json({ ok: true });
}

async function deleteThread(ctx) {
  const u = await requireUser(ctx);
  const t = await loadThread(ctx, Number(ctx.params[0]));
  const admin = isAdmin(u);
  if (!admin && t.user_id !== u.id) fail(403, "You can't delete this thread.", 'owner');
  if (!admin && t.reply_count > 0) fail(403, "Threads with replies can't be deleted.", 'replies');
  await ctx.db.prepare(`UPDATE threads SET deleted = 1 WHERE id = ?1`).bind(t.id).run();
  return json({ ok: true });
}

async function moderate(ctx) {
  const u = await requireUser(ctx);
  if (!isAdmin(u)) fail(403, 'Only admins can do that.', 'admin');
  const t = await loadThread(ctx, Number(ctx.params[0]));
  const b = await ctx.body();
  const pinned = b.pinned === undefined ? t.pinned : (b.pinned ? 1 : 0);
  const locked = b.locked === undefined ? t.locked : (b.locked ? 1 : 0);
  await ctx.db.prepare(`UPDATE threads SET pinned = ?2, locked = ?3 WHERE id = ?1`).bind(t.id, pinned, locked).run();
  return json({ ok: true, pinned: !!pinned, locked: !!locked });
}

// ---- replies -------------------------------------------------------------------------------------------------

async function addReply(ctx) {
  const u = await requireUser(ctx);
  const t = await loadThread(ctx, Number(ctx.params[0]));
  if (t.locked && !isAdmin(u)) fail(403, 'This thread is locked.', 'locked');
  const b = await ctx.body();
  const body = clean(b.body);
  if (body.length < 2) fail(400, 'Reply is empty.', 'body');
  if (body.length > 10000) fail(400, 'Reply is too long.', 'body');
  noImages(body);
  await limit(ctx, 'reply:' + u.id, 1, 10, 'Wait a few seconds before replying again.');
  await limit(ctx, 'reply-day:' + u.id, 300, 86400, 'Daily reply limit reached.');
  const now = Date.now();
  const row = await ctx.db.prepare(`INSERT INTO replies (thread_id, user_id, body, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id`)
    .bind(t.id, u.id, body, now).first();
  const upd = await ctx.db.prepare(
    `UPDATE threads SET reply_count = reply_count + 1, last_post_at = ?2, last_user_id = ?3 WHERE id = ?1 RETURNING reply_count`)
    .bind(t.id, now, u.id).first();
  await ctx.db.prepare(`UPDATE users SET post_count = post_count + 1 WHERE id = ?1`).bind(u.id).run();
  return json({ ok: true, id: row.id, page: Math.max(1, Math.ceil(upd.reply_count / REPLIES_PER_PAGE)) }, 201);
}

async function loadReply(ctx, id) {
  const r = await ctx.db.prepare(
    `SELECT r.* FROM replies r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?1 AND r.deleted = 0 AND t.deleted = 0`).bind(id).first();
  if (!r) fail(404, 'Reply not found.', 'missing');
  return r;
}

async function editReply(ctx) {
  const u = await requireUser(ctx);
  const r = await loadReply(ctx, Number(ctx.params[0]));
  if (r.user_id !== u.id && !isAdmin(u)) fail(403, 'You can only edit your own replies.', 'owner');
  const b = await ctx.body();
  const body = clean(b.body);
  if (body.length < 2 || body.length > 10000) fail(400, 'Replies are 2 to 10,000 characters.', 'body');
  noImages(body);
  await limit(ctx, 'edit:' + u.id, 30, 3600);
  await ctx.db.prepare(`UPDATE replies SET body = ?2, edited_at = ?3 WHERE id = ?1`).bind(r.id, body, Date.now()).run();
  return json({ ok: true });
}

async function deleteReply(ctx) {
  const u = await requireUser(ctx);
  const r = await loadReply(ctx, Number(ctx.params[0]));
  if (r.user_id !== u.id && !isAdmin(u)) fail(403, 'You can only delete your own replies.', 'owner');
  await ctx.db.prepare(`UPDATE replies SET deleted = 1 WHERE id = ?1`).bind(r.id).run();
  const last = await ctx.db.prepare(
    `SELECT created_at, user_id FROM replies WHERE thread_id = ?1 AND deleted = 0 ORDER BY id DESC LIMIT 1`).bind(r.thread_id).first();
  await ctx.db.prepare(
    `UPDATE threads SET reply_count = MAX(0, reply_count - 1),
       last_post_at = COALESCE(?2, created_at), last_user_id = COALESCE(?3, user_id) WHERE id = ?1`)
    .bind(r.thread_id, last ? last.created_at : null, last ? last.user_id : null).run();
  await ctx.db.prepare(`UPDATE users SET post_count = MAX(0, post_count - 1) WHERE id = ?1`).bind(r.user_id).run();
  return json({ ok: true });
}

// ---- profiles ------------------------------------------------------------------------------------------------

async function profile(ctx) {
  const name = String(ctx.params[0] || '').toLowerCase();
  const u = await ctx.db.prepare(`SELECT id, username, created_at, post_count, role FROM users WHERE username_key = ?1`).bind(name).first();
  if (!u) fail(404, 'Member not found.', 'missing');
  const threads = await ctx.db.prepare(
    `SELECT id, game, title, created_at, reply_count FROM threads WHERE user_id = ?1 AND deleted = 0 ORDER BY id DESC LIMIT 10`)
    .bind(u.id).all();
  return json({ user: publicUser(u), threads: threads.results });
}

// ---- routing -------------------------------------------------------------------------------------------------

const ROUTES = [
  ['GET', /^config$/, config],
  ['GET', /^auth\/me$/, me],
  ['POST', /^auth\/register$/, register],
  ['POST', /^auth\/verify-email$/, verifyEmailRoute],
  ['POST', /^auth\/login$/, login],
  ['POST', /^auth\/logout$/, logout],
  ['POST', /^auth\/forgot$/, forgot],
  ['POST', /^auth\/reset$/, reset],
  ['POST', /^account\/password$/, changePassword],
  ['POST', /^account\/email$/, setEmail],
  ['POST', /^account\/email\/resend$/, resendEmail],
  ['POST', /^account\/email\/remove$/, removeEmail],
  ['GET', /^threads$/, listThreads],
  ['POST', /^threads$/, createThread],
  ['GET', /^threads\/(\d{1,12})$/, getThread],
  ['PATCH', /^threads\/(\d{1,12})$/, editThread],
  ['DELETE', /^threads\/(\d{1,12})$/, deleteThread],
  ['POST', /^threads\/(\d{1,12})\/replies$/, addReply],
  ['POST', /^threads\/(\d{1,12})\/moderate$/, moderate],
  ['PATCH', /^replies\/(\d{1,12})$/, editReply],
  ['DELETE', /^replies\/(\d{1,12})$/, deleteReply],
  ['GET', /^users\/([A-Za-z0-9_.-]{1,20})$/, profile],
];

export async function handle(request, env, waitUntil) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  try {
    if (!env.DB) fail(503, 'The forum is opening soon.', 'setup');
    if (method !== 'GET') {
      // browsers always send Origin or Sec-Fetch-Site; a request with neither, from another site, or to an
      // unknown host is refused
      const origin = request.headers.get('Origin');
      const fetchSite = request.headers.get('Sec-Fetch-Site');
      if (!trustedHost(env, url)) fail(403, 'Blocked.', 'origin');
      if (!origin && !fetchSite) fail(403, 'Blocked.', 'origin');
      if (origin && origin !== url.origin) fail(403, 'Blocked.', 'origin');
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') fail(403, 'Blocked.', 'origin');
      if (method !== 'DELETE' && !(request.headers.get('Content-Type') || '').includes('application/json')) fail(415, 'Send JSON.', 'type');
      if (Number(request.headers.get('Content-Length') || 0) > 65536) fail(413, 'That is too long.', 'size');
    }
    let route = null, params = null, pathKnown = false;
    for (const [m, re, fn] of ROUTES) {
      const hit = path.match(re);
      if (!hit) continue;
      pathKnown = true;
      if (m === method) { route = fn; params = hit.slice(1); break; }
    }
    if (!route) fail(pathKnown ? 405 : 404, pathKnown ? 'Not allowed.' : 'Not found.', 'route');
    await ensureSchema(env.DB);

    const secure = url.protocol === 'https:';
    let userPromise = null, bodyPromise = null;
    const ctx = {
      request, env, url, params, secure, db: env.DB, waitUntil,
      ip: request.headers.get('CF-Connecting-IP') || 'local',
      user: () => (userPromise = userPromise || currentUser(env.DB, request, secure)),
      body: () => (bodyPromise = bodyPromise || request.text().then((t) => {
        if (t.length > 65536) fail(413, 'That is too long.', 'size');
        let v;
        try { v = JSON.parse(t || '{}'); } catch (e) { fail(400, 'Bad request.', 'json'); }
        if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'Bad request.', 'json');
        return v;
      })),
    };
    return await route(ctx);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code, ...(e.extra || {}) }, e.status);
    console.error('api error', e && (e.stack || e.message || e));
    return json({ error: 'Something went wrong. Try again.', code: 'server' }, 500);
  }
}
