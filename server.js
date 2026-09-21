const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, nothing to compile
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'site.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT DEFAULT CURRENT_TIMESTAMP, verified INTEGER NOT NULL DEFAULT 0, verify_hash TEXT, verify_expires INTEGER, verify_sent INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pages(id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, html TEXT NOT NULL, members_only INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
// Upgrade older databases that predate email verification
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
for (const [c, def] of [['verified', 'INTEGER NOT NULL DEFAULT 0'], ['verify_hash', 'TEXT'], ['verify_expires', 'INTEGER'], ['verify_sent', 'INTEGER'], ['reset_hash', 'TEXT'], ['reset_expires', 'INTEGER'], ['reset_attempts', 'INTEGER NOT NULL DEFAULT 0']])
  if (!userCols.includes(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} ${def}`);
db.prepare("UPDATE users SET verified=1 WHERE role='admin'").run();
db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());

// Admin account: email defaults to the owner's address; password comes from ADMIN_PASSWORD
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'donryscott28@gmail.com').toLowerCase();
const existingAdmin = db.prepare("SELECT id,email FROM users WHERE role='admin'").get();
if (!existingAdmin) {
  const generated = !process.env.ADMIN_PASSWORD;
  const pass = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users(name,email,hash,role,verified) VALUES(?,?,?,?,1)').run('Admin', ADMIN_EMAIL, bcrypt.hashSync(pass, 12), 'admin');
  console.log(`Admin account created: ${ADMIN_EMAIL}` + (generated ? `  password: ${pass}  (set ADMIN_PASSWORD to choose your own)` : ''));
} else if (existingAdmin.email !== ADMIN_EMAIL) {
  db.prepare('UPDATE users SET email=? WHERE id=?').run(ADMIN_EMAIL, existingAdmin.id);
  console.log(`Admin email updated to ${ADMIN_EMAIL}`);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '20kb' }));

// ---------- optional features (each turns on only when its variables are set) ----------
const GOOGLE_ON = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const AI = process.env.GROQ_API_KEY ? 'groq' : process.env.ANTHROPIC_API_KEY ? 'claude' : null;
const AI_MODEL = process.env.AI_MODEL || (AI === 'groq' ? 'llama-3.3-70b-versatile' : 'claude-haiku-4-5-20251001');
const SECURE = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const baseUrl = req => process.env.BASE_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
const buckets = new Map();
function limited(key, max, ms) { // true when `key` has already used up `max` hits in the last `ms`
  const now = Date.now(), hits = (buckets.get(key) || []).filter(t => now - t < ms);
  if (hits.length >= max) { buckets.set(key, hits); return true; }
  hits.push(now); buckets.set(key, hits); return false;
}
const CHAT_HTML = `<button id="ai-open" class="ai-fab" aria-label="Ask the assistant">Ask AI</button><div id="ai-box" class="ai-box" hidden><div class="ai-head"><b>Studies Hub assistant</b><button id="ai-close" class="link" aria-label="Close">&times;</button></div><div id="ai-log" class="ai-log"></div><form id="ai-form" class="ai-form"><input id="ai-in" placeholder="Ask a question" maxlength="1000" autocomplete="off"><button>Send</button></form></div><script>(function(){var h=[],box=document.getElementById('ai-box'),log=document.getElementById('ai-log'),inp=document.getElementById('ai-in');function add(c,t){var d=document.createElement('div');d.className='ai-m '+c;d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}document.getElementById('ai-open').onclick=function(){box.hidden=!box.hidden;if(!box.hidden){if(!log.children.length)add('bot','Hi! Ask me anything about the pages here.');inp.focus()}};document.getElementById('ai-close').onclick=function(){box.hidden=true};document.getElementById('ai-form').onsubmit=function(e){e.preventDefault();var q=inp.value.trim();if(!q)return;inp.value='';add('me',q);h.push({role:'user',content:q});var w=add('bot','Thinking...');fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:h})}).then(function(r){return r.json()}).then(function(j){var t=j.reply||j.error||'Something went wrong.';w.textContent=t;if(j.reply)h.push({role:'assistant',content:t});else h.pop()}).catch(function(){w.textContent='Network problem. Try again.';h.pop()})}})()</script>`;

// ---------- helpers ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
const safeNext = n => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : '');
function uniqueSlug(base) {
  let s = base, i = 2;
  while (db.prepare('SELECT 1 FROM pages WHERE slug=?').get(s)) s = `${base}-${i++}`;
  return s;
}
const fails = new Map();
const recent = ip => (fails.get(ip) || []).filter(t => Date.now() - t < 9e5);
const tooMany = ip => recent(ip).length >= 10;
const noteFail = ip => fails.set(ip, [...recent(ip), Date.now()]);

// ---------- email verification ----------
// Railway blocks SMTP on Free/Trial/Hobby plans, so use an HTTPS email API there (Resend or Brevo).
// SMTP (Gmail etc.) still works on your own computer, a phone, a VPS, or a Railway Pro plan.
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

let gTok = { t: null, exp: 0 };
async function googleAccessToken() {
  if (gTok.t && Date.now() < gTok.exp) return gTok.t;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: process.env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' })
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Google token: ' + (j.error_description || j.error || r.status));
  gTok = { t: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return gTok.t;
}

// Sends through the Gmail API over HTTPS, so it works on Railway (unlike SMTP)
async function gmailSend(to, subject, text, html) {
  const addr = process.env.EMAIL_FROM || ADMIN_EMAIL, b = 'sh_' + crypto.randomBytes(8).toString('hex');
  const w = s => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  const raw = [`From: Studies Hub <${addr}>`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', w(text),
    `--${b}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', w(html), `--${b}--`].join('\r\n');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${await googleAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') })
  });
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${await r.text()}`);
}

async function deliver(to, subject, text, html) {
  const from = process.env.MAIL_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER;
  if (GOOGLE_ON && process.env.GOOGLE_REFRESH_TOKEN) {
    await gmailSend(to, subject, text, html);
  } else if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html })
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  } else if (process.env.BREVO_API_KEY) {
    const m = /^(.*)<(.+)>\s*$/.exec(from || '');
    const name = m && m[1].trim();
    const sender = m ? { email: m[2].trim(), ...(name ? { name } : {}) } : { email: from };
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html })
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
  } else if (mailer) {
    await mailer.sendMail({ from, to, subject, text, html });
  } else return false;
  return true;
}

async function sendVerification(req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE users SET verify_hash=?, verify_expires=?, verify_sent=? WHERE id=?').run(sha(token), Date.now() + 864e5, Date.now(), user.id);
  const base = baseUrl(req);
  const link = `${base}/verify?token=${token}`;
  const sent = await deliver(user.email, 'Verify your email for Studies Hub',
    `Hi ${user.name},\n\nConfirm your email to activate your account:\n${link}\n\nThis link expires in 24 hours. If you did not sign up, ignore this email.`,
    `<p>Hi ${esc(user.name)},</p><p><a href="${link}">Confirm your email</a> to activate your account.</p><p>This link expires in 24 hours. If you did not sign up, ignore this email.</p>`);
  if (!sent) console.log(`[email not configured] Verification link for ${user.email}: ${link}`);
}

async function sendResetCode(email, code) {
  const sent = await deliver(email, 'Your Studies Hub password reset code',
    `Your password reset code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
    `<p>Your password reset code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>It expires in 10 minutes. If you did not ask for it, ignore this email.</p>`);
  if (!sent) console.log(`[email not configured] Reset code for ${email}: ${code}`);
}

async function sendSafely(req, u) {
  if (Date.now() - (u.verify_sent || 0) < 60000) return 'wait'; // 1-minute cooldown per account
  try { await sendVerification(req, u); return 'sent'; }
  catch (e) { console.error('Verification email failed:', e.message); return 'fail'; }
}

function startSession(res, userId) {
  const sid = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sid, userId, Date.now() + 7 * 864e5);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

app.get('/health', (req, res) => res.type('text').send('ok'));

app.use((req, res, next) => {
  const c = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sid='));
  req.sid = c ? c.slice(4) : null;
  req.user = req.sid
    ? db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires>?').get(req.sid, Date.now()) || null
    : null;
  next();
});

const admin = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next()
    : req.method === 'GET' ? res.redirect('/login?next=/admin') : res.sendStatus(403);

const CSS = `:root{--bg:#12121c;--panel:rgba(32,48,96,.30);--line:rgba(56,176,248,.24);--fg:#eaf2ff;--mut:#93a0bd;--blue:#38b0f8;--blue2:#1c7fe0;--pink:#f000e8;color-scheme:dark;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
html{background:var(--bg);scroll-padding-top:env(safe-area-inset-top,0px)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:radial-gradient(900px 520px at 12% -8%,rgba(56,176,248,.22),transparent 62%),radial-gradient(700px 440px at 96% 4%,rgba(240,0,232,.13),transparent 60%),var(--bg);background-attachment:fixed}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 20px;max-width:1000px;margin:0 auto}
.brand{display:flex;align-items:center;gap:10px;color:var(--fg);font-weight:700;font-size:18px}.brand:hover{text-decoration:none}
.logo{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--blue),var(--pink));box-shadow:0 0 14px rgba(56,176,248,.7)}
nav{display:flex;align-items:center;gap:10px}nav form{margin:0}
main{max-width:1000px;margin:0 auto;padding:12px 20px 32px}
.btn,button{display:inline-block;font:inherit;font-weight:600;cursor:pointer;color:#04101f;background:linear-gradient(135deg,#5bc8ff,var(--blue) 55%,var(--blue2));border:0;border-radius:10px;padding:9px 18px;margin:6px 0;box-shadow:0 0 18px rgba(56,176,248,.35)}
.btn:hover,button:hover{filter:brightness(1.1);text-decoration:none}
.btn.ghost,button.ghost{background:transparent;color:var(--blue);border:1px solid var(--line);box-shadow:none}
button.link{background:none;color:var(--mut);box-shadow:none;padding:0;margin:0;font-weight:500}button.link:hover{color:var(--blue);filter:none}
input{font:inherit;width:100%;padding:11px 13px;margin:6px 0;color:var(--fg);background:rgba(8,10,22,.65);border:1px solid var(--line);border-radius:10px;outline:0}
input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(56,176,248,.2)}
input::placeholder{color:#6b7794}input[type=checkbox]{width:auto}
.card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;margin:14px 0}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.mut{color:var(--mut);font-size:14px}.err{color:#ff7ab8}
h1{font-size:clamp(28px,6vw,44px);line-height:1.15;margin:.2em 0}h2,h3{margin:.8em 0 .3em}.sec{margin-top:28px}
.hero{text-align:center;padding:44px 0 24px}
.eyebrow{color:var(--blue);letter-spacing:3px;text-transform:uppercase;font-size:13px;margin:0}
.grad{background:linear-gradient(90deg,var(--blue),#8ad8ff 50%,var(--pink));-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{color:var(--mut);max-width:520px;margin:12px auto 20px;font-size:18px}
.cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.tile{display:flex;flex-direction:column;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;color:var(--fg);transition:.2s}
.tile:hover{transform:translateY(-3px);border-color:var(--blue);box-shadow:0 0 24px rgba(56,176,248,.25);text-decoration:none}
.tile h3{margin:0;font-size:18px}.go{color:var(--blue);font-size:14px}
.chip{align-self:flex-start;font-size:12px;padding:2px 10px;border-radius:99px;border:1px solid var(--line);color:var(--blue)}
.chip.lock{color:#ff7cf5;border-color:rgba(240,0,232,.45)}
.auth{max-width:420px;margin:28px auto}.auth h1{font-size:30px;text-align:center}.auth>p{text-align:center}.auth .card button{width:100%}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}th{color:var(--mut);font-weight:500}
footer{text-align:center;color:var(--mut);font-size:13px;padding:20px}
.gbtn{display:block;text-align:center;width:100%}
.stat{display:block;font-size:30px;font-weight:700;line-height:1.2}
.ai-fab{position:fixed;right:16px;bottom:16px;margin-bottom:env(safe-area-inset-bottom,0px);z-index:20;border-radius:99px;padding:12px 18px}
.ai-box{position:fixed;right:16px;bottom:72px;margin-bottom:env(safe-area-inset-bottom,0px);z-index:20;width:min(360px,calc(100vw - 32px));height:min(460px,calc(100vh - 140px));display:flex;flex-direction:column;background:#161628;border:1px solid var(--line);border-radius:16px;box-shadow:0 0 30px rgba(56,176,248,.25)}
.ai-box[hidden]{display:none}
.ai-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}.ai-head button{font-size:22px;line-height:1}
.ai-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.ai-m{max-width:85%;padding:8px 12px;border-radius:12px;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere}
.ai-m.me{align-self:flex-end;background:linear-gradient(135deg,#5bc8ff,var(--blue2));color:#04101f}.ai-m.bot{align-self:flex-start;background:var(--panel);border:1px solid var(--line)}
.ai-form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}.ai-form input,.ai-form button{margin:0}`;

const layout = (title, body, user) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="/"><span class="logo"></span>Studies Hub</a><nav>${user
    ? `<a class="btn ghost" href="/dashboard">Dashboard</a>${user.role === 'admin' ? '<a class="btn ghost" href="/admin">Admin</a>' : ''}<form method="post" action="/logout"><button class="ghost">Log out</button></form>`
    : '<a class="btn ghost" href="/login">Log in</a><a class="btn" href="/signup">Sign up</a>'}</nav></header>
<main>${body}</main><footer>&copy; ${new Date().getFullYear()} Studies Hub</footer>${user && AI ? CHAT_HTML : ''}</body></html>`;

const authForm = (kind, err = '', next = '') => {
  const login = kind === 'login';
  return layout(login ? 'Log in' : 'Sign up', `<div class="auth"><h1>${login ? 'Welcome back' : 'Create your account'}</h1>
<p class="mut">${login ? 'Log in to open members-only pages.' : 'It is free. We will email you a link to confirm your address.'}</p>${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" class="card">${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
${login ? '' : '<input name="name" placeholder="Your name" required maxlength="80">'}
<input name="email" type="email" placeholder="Email address" required>
<input name="password" type="password" placeholder="Password${login ? '' : ' (8+ characters)'}" required>
<button>${login ? 'Log in' : 'Create account'}</button></form>
${GOOGLE_ON ? '<a class="btn ghost gbtn" href="/auth/google">Continue with Google</a>' : ''}
${login ? '<p class="mut"><a href="/forgot">Forgot password?</a></p>' : ''}
<p class="mut">${login ? 'New here? <a href="/signup">Create an account</a>' : 'Already registered? <a href="/login">Log in</a>'}</p></div>`, null);
};

const forgotForm = (err = '') => layout('Forgot password', `<div class="auth"><h1>Reset your password</h1><p class="mut">Enter your email and we will send a 6-digit code.</p>${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" class="card"><input name="email" type="email" placeholder="Email address" required><button>Send code</button></form>
<p class="mut"><a href="/login">Back to log in</a></p></div>`, null);

const resetForm = (email = '', err = '') => layout('Enter your code', `<div class="auth"><h1>Enter your code</h1><p class="mut">If that email is registered, a 6-digit code is on its way. It expires in 10 minutes.</p>${err ? `<p class="err">${esc(err)}</p>` : ''}
<form method="post" class="card"><input name="email" type="email" placeholder="Email address" value="${esc(email)}" required>
<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6-digit code" required>
<input name="password" type="password" placeholder="New password (8+ characters)" minlength="8" required><button>Set new password</button></form>
<p class="mut"><a href="/forgot">Send a new code</a></p></div>`, null);

const notice = (title, msg, extra = '') => layout(title, `<div class="auth"><h1>${esc(title)}</h1><p class="mut">${esc(msg)}</p>${extra}</div>`, null);
const resendForm = (email = '') => `<form method="post" action="/resend" class="card"><input name="email" type="email" placeholder="Email" value="${esc(email)}" required><button>Resend verification email</button></form>`;
const checkEmailPage = email => notice('Check your email', `We sent a verification link to ${email}. Click it to activate your account (it expires in 24 hours).`, resendForm(email));

// ---------- public + auth routes ----------
app.get('/', (req, res) => {
  const pages = db.prepare('SELECT slug,title,members_only FROM pages ORDER BY id DESC').all();
  const hero = `<section class="hero"><p class="eyebrow">Welcome</p><h1>Explore our <span class="grad">pages</span></h1>
<p class="lead">Browse what is live, or create a free account to unlock members-only content.</p>${req.user
    ? `<p class="lead">Signed in as ${esc(req.user.name)}.</p><div class="cta"><a class="btn" href="/dashboard">Open dashboard</a></div>`
    : '<div class="cta"><a class="btn" href="/signup">Create account</a><a class="btn ghost" href="/login">Log in</a></div>'}</section>`;
  const grid = pages.length
    ? `<div class="grid">${pages.map(p => `<a class="tile" href="/p/${p.slug}"><span class="chip${p.members_only ? ' lock' : ''}">${p.members_only ? 'Members' : 'Open'}</span><h3>${esc(p.title)}</h3><span class="go">View page &rarr;</span></a>`).join('')}</div>`
    : '<p class="mut">Nothing published yet. Check back soon.</p>';
  res.send(layout('Studies Hub', `${hero}<h2 class="sec">Pages</h2>${grid}`, req.user));
});

// Uploaded pages open full-screen with their own design. We only make sure they display well on phones
// (charset + viewport tags if missing) and add one small "back" button so visitors are never stuck.
function preparePage(html, home) {
  let h = String(html).replace(/^\uFEFF/, '');
  const add = [];
  if (!/<meta[^>]+charset/i.test(h)) add.push('<meta charset="utf-8">');
  if (!/<meta[^>]+name\s*=\s*["']?viewport/i.test(h)) add.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  if (add.length) {
    const tags = add.join('');
    if (/<head[^>]*>/i.test(h)) h = h.replace(/<head[^>]*>/i, m => m + tags);
    else if (/<html[^>]*>/i.test(h)) h = h.replace(/<html[^>]*>/i, m => m + '<head>' + tags + '</head>');
    else h = h.replace(/^(\s*<!doctype[^>]*>)?/i, m => m + tags);
  }
  const back = `<a href="${home}" style="position:fixed;left:12px;bottom:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483647;font:600 13px system-ui,sans-serif;color:#eaf2ff;background:rgba(18,18,28,.85);border:1px solid rgba(56,176,248,.55);border-radius:99px;padding:8px 14px;text-decoration:none">&larr; Studies Hub</a>`;
  let at = -1, m; const re = /<\/body>/gi;
  while ((m = re.exec(h))) at = m.index;
  return at >= 0 ? h.slice(0, at) + back + h.slice(at) : h + back;
}

app.get('/p/:slug', (req, res) => {
  const p = db.prepare('SELECT html,members_only FROM pages WHERE slug=?').get(req.params.slug);
  if (!p) return res.status(404).send(layout('Not found', '<h2>Page not found</h2>', req.user));
  if (p.members_only && !req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type('html').send(preparePage(p.html, req.user ? '/dashboard' : '/'));
});

app.get('/signup', (req, res) => res.send(authForm('signup')));
app.post('/signup', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const bad = m => res.status(400).send(authForm('signup', m));
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return bad('Enter your name and a valid email.');
  if (pw.length < 8) return bad('Password must be at least 8 characters.');
  let u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (u && u.verified) return bad('That email is already registered. Try logging in.');
  if (!u) { // an existing unverified account is never modified here, only re-sent a link
    const id = db.prepare('INSERT INTO users(name,email,hash) VALUES(?,?,?)').run(name, email, bcrypt.hashSync(pw, 12)).lastInsertRowid;
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  if ((await sendSafely(req, u)) === 'fail') return bad("We couldn't send the verification email. Please try again in a minute.");
  res.send(checkEmailPage(email));
});

app.get('/login', (req, res) => res.send(authForm('login', '', safeNext(req.query.next))));
app.post('/login', (req, res) => {
  const next = safeNext(req.body.next);
  if (tooMany(req.ip)) return res.status(429).send(authForm('login', 'Too many attempts. Try again in 15 minutes.', next));
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) {
    noteFail(req.ip);
    return res.status(401).send(authForm('login', 'Wrong email or password.', next));
  }
  if (!u.verified) return res.status(403).send(notice('Verify your email', 'Your email is not verified yet. Check your inbox for the link, or request a new one.', resendForm(u.email)));
  startSession(res, u.id);
  res.redirect(next || '/dashboard');
});

app.get('/verify', (req, res) => {
  const token = String(req.query.token || '');
  const u = token && db.prepare('SELECT id FROM users WHERE verify_hash=? AND verify_expires>?').get(sha(token), Date.now());
  if (!u) return res.status(400).send(notice('Link invalid or expired', 'Request a new verification email below.', resendForm()));
  db.prepare('UPDATE users SET verified=1, verify_hash=NULL, verify_expires=NULL WHERE id=?').run(u.id);
  res.send(notice('Email verified', 'Your account is active.', '<p><a href="/login">Log in</a></p>'));
});

app.post('/resend', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=? AND verified=0').get(email);
  if (u) await sendSafely(req, u);
  res.send(notice('Check your email', 'If that address has an unverified account, a new link is on its way.', resendForm(email)));
});

// ---------- forgot password: 6-digit email code (same flow for every account, admin included) ----------
app.get('/forgot', (req, res) => res.send(forgotForm()));
app.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (limited('forgot-ip:' + req.ip, 8, 15 * 60e3)) return res.status(429).send(forgotForm('Too many requests. Try again in a few minutes.'));
  const u = email && db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (u && !limited('forgot-em:' + email, 3, 15 * 60e3)) {
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare('UPDATE users SET reset_hash=?, reset_expires=?, reset_attempts=0 WHERE id=?').run(bcrypt.hashSync(code, 10), Date.now() + 600000, u.id);
    try { await sendResetCode(u.email, code); } catch (e) { console.error('Reset email failed:', e.message); }
  }
  res.redirect('/reset?email=' + encodeURIComponent(email)); // identical whether or not the account exists
});

app.get('/reset', (req, res) => res.send(resetForm(String(req.query.email || ''))));
app.post('/reset', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim(), pw = String(req.body.password || '');
  const bad = m => res.status(400).send(resetForm(email, m));
  if (limited('reset-ip:' + req.ip, 10, 15 * 60e3)) return res.status(429).send(resetForm(email, 'Too many attempts. Try again in a few minutes.'));
  if (pw.length < 8) return bad('Password must be at least 8 characters.');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !u.reset_hash || !u.reset_expires) return bad('Invalid or expired code.');
  const clear = () => db.prepare('UPDATE users SET reset_hash=NULL, reset_expires=NULL, reset_attempts=0 WHERE id=?').run(u.id);
  if (Date.now() > u.reset_expires) { clear(); return bad('That code expired. Request a new one.'); }
  const attempts = (u.reset_attempts || 0) + 1;
  if (attempts > 5) { clear(); return bad('Too many wrong codes. Request a new one.'); }
  db.prepare('UPDATE users SET reset_attempts=? WHERE id=?').run(attempts, u.id);
  if (!bcrypt.compareSync(code, u.reset_hash)) return bad('Invalid or expired code.');
  db.prepare('UPDATE users SET hash=?, verified=1, reset_hash=NULL, reset_expires=NULL, reset_attempts=0 WHERE id=?').run(bcrypt.hashSync(pw, 12), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  res.send(notice('Password updated', 'You can now log in with your new password.', '<p><a class="btn" href="/login">Log in</a></p>'));
});

// ---------- Continue with Google ----------
const gRedirect = req => process.env.GOOGLE_REDIRECT_URI || `${baseUrl(req)}/auth/google/callback`;
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_ON) return res.redirect('/login');
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `gstate=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${SECURE}`);
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: gRedirect(req), response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account'
  }));
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('gstate='));
    if (!GOOGLE_ON || !req.query.code || !c || c.slice(7) !== req.query.state) throw new Error('state mismatch');
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(req.query.code), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: gRedirect(req), grant_type: 'authorization_code' })
    });
    const t = await tr.json();
    if (!tr.ok) throw new Error(t.error_description || t.error);
    const g = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    if (!g.email || !g.email_verified) throw new Error('Google email not verified');
    const email = g.email.toLowerCase(), rnd = () => bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
    let u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u) {
      const id = db.prepare('INSERT INTO users(name,email,hash,verified) VALUES(?,?,?,1)').run(String(g.name || email.split('@')[0]).slice(0, 80), email, rnd()).lastInsertRowid;
      u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    } else if (!u.verified) { // drop any password someone set before the real owner proved the email
      db.prepare('UPDATE users SET verified=1, hash=? WHERE id=?').run(rnd(), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    }
    startSession(res, u.id);
    res.redirect('/dashboard');
  } catch (e) {
    console.error('Google sign-in failed:', e.message);
    res.status(400).send(notice('Google sign-in failed', 'Please try again, or use your email and password.', '<p><a class="btn" href="/login">Back to log in</a></p>'));
  }
});

// ---------- AI assistant (Groq or Claude; members only, rate-limited) ----------
async function askAI(messages, system) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
  try {
    if (AI === 'groq') {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 500, temperature: 0.5, messages: [{ role: 'system', content: system }, ...messages] })
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || r.status);
      return j.choices[0].message.content;
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 500, system, messages })
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || r.status);
    return j.content.filter(b => b.type === 'text').map(b => b.text).join('');
  } finally { clearTimeout(timer); }
}

app.post('/api/chat', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in to use the assistant.' });
  if (!AI) return res.status(503).json({ error: 'The assistant is not set up yet.' });
  if (limited('chat:' + req.user.id, 20, 10 * 60e3)) return res.status(429).json({ error: 'Slow down a little and try again in a few minutes.' });
  const msgs = (Array.isArray(req.body.messages) ? req.body.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-10).map(m => ({ role: m.role, content: m.content.slice(0, 1000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Send a question first.' });
  const pages = db.prepare('SELECT slug,title FROM pages ORDER BY id DESC LIMIT 50').all();
  const system = `You are the assistant for Studies Hub, a website that hosts study pages. Answer clearly and briefly in plain language, and say so when you are not sure. Pages currently on the site: ${pages.map(p => `${p.title} (/p/${p.slug})`).join(', ') || 'none yet'}. Do not invent pages or features that are not listed.`;
  try { res.json({ reply: await askAI(msgs, system) }); }
  catch (e) { console.error('AI error:', e.message); res.status(502).json({ error: 'The assistant could not answer right now. Please try again.' }); }
});

app.post('/logout', (req, res) => {
  if (req.sid) db.prepare('DELETE FROM sessions WHERE id=?').run(req.sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/');
});

// ---------- admin ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const back = msg => '/admin?msg=' + encodeURIComponent(msg);

// ---------- dashboard (everyone who is logged in) ----------
app.get('/dashboard', (req, res) => {
  if (!req.user) return res.redirect('/login?next=/dashboard');
  const u = req.user, isAdmin = u.role === 'admin';
  const count = sql => db.prepare(sql).get().n;
  const tile = (href, icon, title, sub, extra = '') => `<a class="tile" href="${href}"${extra}><span class="stat">${icon}</span><h3>${title}</h3><span class="mut">${sub}</span></a>`;
  const shortcuts = [
    tile('/', '🌐', 'Browse pages', 'See everything that is live'),
    AI ? tile('#', '💬', 'Ask the assistant', 'Get quick answers', ' onclick="document.getElementById(\'ai-open\').click();return false"') : '',
    isAdmin ? tile('/admin#upload', '⬆️', 'Upload a page', 'Add a new HTML file') : '',
    isAdmin ? tile('/admin#pages', '🗂️', 'Manage pages', 'Replace, lock or delete') : '',
    isAdmin ? tile('/admin#users', '👥', 'Users', 'Verify or remove accounts') : ''
  ].join('');
  const stats = isAdmin ? `<div class="grid">${[
    ['Pages', count('SELECT COUNT(*) n FROM pages')], ['Users', count('SELECT COUNT(*) n FROM users')], ['Waiting to verify', count('SELECT COUNT(*) n FROM users WHERE verified=0')]
  ].map(([k, v]) => `<div class="tile"><span class="stat">${v}</span><span class="mut">${k}</span></div>`).join('')}</div>` : '';
  const recent = db.prepare('SELECT slug,title,members_only FROM pages ORDER BY id DESC LIMIT 5').all();
  res.send(layout('Dashboard', `<div class="hero" style="padding:28px 0 8px;text-align:left"><p class="eyebrow">Dashboard</p><h1>Hello, ${esc(u.name)}</h1><p class="mut">${isAdmin ? 'You are the admin. Manage the whole site from here.' : 'Everything you can do on Studies Hub, in one place.'}</p></div>
${stats}<h2 class="sec">Shortcuts</h2><div class="grid">${shortcuts}</div>
<h2 class="sec">Latest pages</h2>${recent.length
    ? `<div class="grid">${recent.map(p => `<a class="tile" href="/p/${p.slug}"><span class="chip${p.members_only ? ' lock' : ''}">${p.members_only ? 'Members' : 'Open'}</span><h3>${esc(p.title)}</h3><span class="go">View page &rarr;</span></a>`).join('')}</div>`
    : '<p class="mut">Nothing published yet.</p>'}
<h2 class="sec">Your account</h2><div class="card row"><div><b>${esc(u.name)}</b><br><span class="mut">${esc(u.email)} &middot; ${u.verified ? 'email verified' : 'email not verified'} &middot; joined ${esc(String(u.created_at).slice(0, 10))}</span></div><form method="post" action="/logout"><button class="ghost">Log out</button></form></div>`, u));
});

app.get('/admin', admin, (req, res) => {
  const pages = db.prepare('SELECT * FROM pages ORDER BY id DESC').all();
  const users = db.prepare('SELECT id,name,email,role,verified,created_at FROM users ORDER BY id DESC').all();
  res.send(layout('Admin', `<p class="mut"><a href="/dashboard">&larr; Dashboard</a></p><h1>Admin</h1>${req.query.msg ? `<p class="mut">${esc(req.query.msg)}</p>` : ''}
<form class="card" id="upload" method="post" action="/admin/upload" enctype="multipart/form-data"><h3>Upload an HTML page</h3>
<input name="title" placeholder="Title (optional — defaults to file name)">
<input type="file" name="file" accept=".html,.htm,text/html" required>
<label><input type="checkbox" name="members_only" value="1"> Members only (login required)</label><br><button>Upload</button></form>
<h3 id="pages">Pages (${pages.length})</h3>${pages.map(p => `<div class="card"><div class="row"><a href="/p/${p.slug}" target="_blank">${esc(p.title)}</a><span class="mut">/p/${p.slug}</span></div>
<div class="row" style="margin-top:10px">
<form method="post" action="/admin/pages/${p.id}/toggle"><button class="link">${p.members_only ? '🔒 Members only — make open' : 'Open — make members only'}</button></form>
<form method="post" action="/admin/pages/${p.id}/replace" enctype="multipart/form-data" class="row"><input type="file" name="file" accept=".html,.htm" required style="width:auto"><button>Replace file</button></form>
<form method="post" action="/admin/pages/${p.id}/delete" onsubmit="return confirm('Delete this page?')"><button class="link">Delete</button></form></div></div>`).join('')
    || '<p class="mut">No pages yet.</p>'}
<h3 id="users">Registered users (${users.length})</h3><div style="overflow-x:auto"><table><tr><th>Name</th><th>Email</th><th>Joined</th><th>Status</th><th></th></tr>${users.map(u =>
      `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(String(u.created_at).slice(0, 10))}</td><td>${u.verified ? 'verified' : `<form method="post" action="/admin/users/${u.id}/verify"><button class="link">Unverified: verify now</button></form>`}</td><td>${u.role === 'admin' ? 'admin'
        : `<form method="post" action="/admin/users/${u.id}/delete" onsubmit="return confirm('Remove this user?')"><button class="link">Remove</button></form>`}</td></tr>`).join('')}</table></div>`, req.user));
});

app.post('/admin/upload', admin, upload.single('file'), (req, res) => {
  if (!req.file) return res.redirect(back('Choose a file first.'));
  const base = req.file.originalname.replace(/\.html?$/i, '');
  const slug = uniqueSlug(slugify(base));
  db.prepare('INSERT INTO pages(slug,title,html,members_only) VALUES(?,?,?,?)')
    .run(slug, (req.body.title || '').trim() || base, req.file.buffer.toString('utf8'), req.body.members_only ? 1 : 0);
  res.redirect(back(`Published at /p/${slug}`));
});

app.post('/admin/pages/:id/replace', admin, upload.single('file'), (req, res) => {
  if (!req.file) return res.redirect(back('Choose a file first.'));
  db.prepare('UPDATE pages SET html=? WHERE id=?').run(req.file.buffer.toString('utf8'), req.params.id);
  res.redirect(back('File replaced.'));
});
app.post('/admin/pages/:id/toggle', admin, (req, res) => {
  db.prepare('UPDATE pages SET members_only = 1 - members_only WHERE id=?').run(req.params.id);
  res.redirect('/admin');
});
app.post('/admin/pages/:id/delete', admin, (req, res) => {
  db.prepare('DELETE FROM pages WHERE id=?').run(req.params.id);
  res.redirect(back('Page deleted.'));
});
app.post('/admin/users/:id/verify', admin, (req, res) => {
  db.prepare('UPDATE users SET verified=1, verify_hash=NULL, verify_expires=NULL WHERE id=?').run(req.params.id);
  res.redirect(back('User verified.'));
});
app.post('/admin/users/:id/delete', admin, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.params.id);
  db.prepare("DELETE FROM users WHERE id=? AND role!='admin'").run(req.params.id);
  res.redirect(back('User removed.'));
});

app.use((err, req, res, next) => res.status(400).send(layout('Error', `<h2>Something went wrong</h2><p class="mut">${esc(err.message)} (uploads are limited to 5 MB)</p>`, req.user)));

app.listen(PORT, () => console.log(`Studies Hub running on http://localhost:${PORT}`));
