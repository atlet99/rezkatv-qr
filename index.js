'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const https   = require('https');
const zlib    = require('zlib');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // Trust first proxy (nginx)

// Utility to mask login/email (e.g. user@email.com -> us***@e***.com, login -> lo***)
function maskLogin(login) {
  if (!login || typeof login !== 'string') return '***';
  if (login.includes('@')) {
    const [name, domain] = login.split('@');
    const maskedName = name.length > 2 ? name.slice(0, 2) + '*'.repeat(name.length - 2) : name + '*';
    const domainParts = domain.split('.');
    const ext = domainParts.length > 1 ? '.' + domainParts.pop() : '';
    const dName = domainParts.join('.');
    const maskedDomain = dName.length > 1 ? dName[0] + '*'.repeat(dName.length - 1) : dName + '*';
    return `${maskedName}@${maskedDomain}${ext}`;
  }
  return login.length > 2 ? login.slice(0, 2) + '*'.repeat(login.length - 2) : login + '*';
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/session/')) return;
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.ip || req.socket.remoteAddress || '-';
    const safeUrl = req.originalUrl.replace(/([?&]t=)[a-f0-9]{8,}/i, '$1***');
    const ua = (req.headers['user-agent'] || '-').toString().slice(0, 120);
    console.log(`[HTTP] ${req.method} ${safeUrl} -> ${res.statusCode} ${Date.now() - start}ms ip=${ip} ua="${ua}"`);
  });
  next();
});

// Rate limits
const createSessionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // Limit each IP to 5 requests per windowMs
  message: { error: 'Слишком много попыток создания сессии. Попробуйте позже.' }
});

const submitAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // Max 10 attempts to prevent bruteforce
  message: { success: false, error: 'Слишком много попыток входа. Попробуйте позже.' }
});

const sessions = {};
const TOKEN_TTL = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = Number.parseInt(process.env.AUTH_TIMEOUT_MS || '10000', 10) || 10000;
const AUTH_ERROR_CODES = new Set(['csrf_missing', 'login_failed', 'mirror_unreachable', 'timeout']);
const LOG_PENDING_CHECKS = process.env.LOG_PENDING_CHECKS === '1';

setInterval(() => {
  const now = Date.now();
  for (const token in sessions) {
    if (now - sessions[token].createdAt > TOKEN_TTL) {
      console.log(`[Session] Timeout for token: ${token.slice(0, 8)}...`);
      delete sessions[token];
    }
  }
}, 60_000);

app.post('/session/create', createSessionLimiter, (req, res) => {
  if (Object.keys(sessions).length >= 100) {
    return res.status(429).json({ error: 'Сервер временно перегружен сессиями. Попробуйте позже.' });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const host  = req.body.host || process.env.HDREZKA_HOST || 'hdrezka.ag';
  sessions[token] = { status: 'pending', phase: 'idle', host, createdAt: Date.now() };
  console.log(`[Session] Created token: ${token.slice(0, 8)}... for host: ${host}`);
  res.json({ token });
});

app.get('/session/check', (req, res) => {
  const token = (req.query.t || '').toString();
  const session = sessions[req.query.t];
  if (!session) {
    console.warn(`[SessionCheck] expired token=${token.slice(0, 8)}...`);
    return res.json({ status: 'expired' });
  }
  if (session.status === 'done') {
    const { cookies, host, phase } = session;
    delete sessions[req.query.t];
    console.log(`[Session] Handed over cookies for token: ${req.query.t.slice(0, 8)}...`);
    return res.json({ status: 'done', cookies, host, phase });
  }
  if (session.status === 'error') {
    console.warn(`[SessionCheck] error token=${token.slice(0, 8)}... host=${session.host} phase=${session.phase || 'unknown'} reason=${session.error}`);
    return res.json({ status: 'error', error: session.error, host: session.host, phase: session.phase || 'unknown' });
  }
  if (LOG_PENDING_CHECKS) {
    console.log(`[SessionCheck] pending token=${token.slice(0, 8)}... host=${session.host} phase=${session.phase || 'unknown'}`);
  }
  res.json({ status: 'pending', host: session.host, phase: session.phase || 'unknown' });
});

app.post('/session/submit', submitAuthLimiter, async (req, res) => {
  const { token, login, password } = req.body;
  console.log(`[Auth] /session/submit token=${(token || '').toString().slice(0, 8)}... login_present=${Boolean(login)} password_present=${Boolean(password)}`);
  if (!token || !login || !password) {
    console.warn(`[Auth] Rejecting submit: missing_fields token=${(token || '').toString().slice(0, 8)}...`);
    return res.status(400).json({ success: false, error: 'Не все поля заполнены' });
  }

  const session = sessions[token];
  if (!session) {
    console.warn(`[Auth] Rejecting submit: session_expired token=${token.slice(0, 8)}...`);
    return res.status(400).json({ success: false, error: 'QR-код истёк, обновите его на телевизоре' });
  }

  try {
    updateSession(token, { status: 'pending', phase: 'login_get_page', error: null });
    console.log(`[Auth] Attempting login for ${maskLogin(login)} on ${session.host} (token: ${token.slice(0, 8)}...)`);
    const cookies = await loginToHDRezka(session.host, login, password, (phase) => {
      updateSession(token, { phase });
      console.log(`[Auth] Phase=${phase} host=${session.host} token=${token.slice(0, 8)}...`);
    });
    updateSession(token, { status: 'done', phase: 'done', cookies, error: null });
    console.log(`[Auth] Success for ${maskLogin(login)} (token: ${token.slice(0, 8)}...)`);
    res.json({ success: true });
  } catch (err) {
    const code = normalizeAuthError(err);
    updateSession(token, { status: 'error', error: code, phase: sessions[token]?.phase || 'unknown' });
    console.error(`[Auth] Error for ${maskLogin(login)}: code=${code} detail="${err.message}" syscode=${err.code || 'n/a'} host=${session.host} phase=${sessions[token]?.phase || 'unknown'} token=${token.slice(0, 8)}...`);
    res.json({ success: false, error: code });
  }
});

app.get('/auth', (req, res) => {
  if (!req.query.t || !sessions[req.query.t])
    return res.status(400).send('QR-код истёк или недействителен. Обновите его на телевизоре.');
  res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

function updateSession(token, patch) {
  if (!sessions[token]) return;
  sessions[token] = { ...sessions[token], ...patch };
}

function createAuthError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function normalizeAuthError(err) {
  if (err && AUTH_ERROR_CODES.has(err.code)) return err.code;
  if (err && (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT' || err.code === 'ERR_REQUEST_TIMEOUT')) return 'timeout';
  if (err && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(err.code)) return 'mirror_unreachable';
  return 'login_failed';
}

function extractCookies(headers) {
  return (headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

function mergeCookies(...cookieStrings) {
  const jar = new Map();
  for (const cookieString of cookieStrings.filter(Boolean)) {
    for (const part of cookieString.split(';')) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.includes('=')) continue;
      const eq = trimmed.indexOf('=');
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      jar.set(key, value);
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function hasAuthCookie(cookieString) {
  return /(^|;\s*)(member_id|member_hash|member_user_id|dle_user_id|dle_password)=/i.test(cookieString || '');
}

function hasVerifiedMemberUserId(body, cookieString) {
  const bodyPatterns = [
    /id=(['"])member_user_id\1[^>]*value=(['"])(\d+)\2/i,
    /value=(['"])(\d+)\1[^>]*id=(['"])member_user_id\3/i,
    /\bmember_user_id\s*[:=]\s*['"]?(\d+)['"]?/i,
  ];
  let bodyMemberId = 0;
  for (const pattern of bodyPatterns) {
    const match = body.match(pattern);
    if (!match) continue;
    const numericGroup = match.find(part => /^\d+$/.test(part || ''));
    if (numericGroup) {
      bodyMemberId = parseInt(numericGroup, 10);
      break;
    }
  }

  const cookieMatch = (cookieString || '').match(/(?:^|;\s*)member_user_id=(\d+)/i);
  const cookieMemberId = cookieMatch ? parseInt(cookieMatch[1], 10) : 0;

  return Number.isFinite(bodyMemberId) && bodyMemberId > 0
    || Number.isFinite(cookieMemberId) && cookieMemberId > 0;
}

function extractCsrfToken(body) {
  const hiddenInput = body.match(/name=(['"])dle_login_hash\1[^>]*value=(['"])([^'"]+)\2/i)
    || body.match(/value=(['"])([^'"]+)\1[^>]*name=(['"])dle_login_hash\3/i);
  if (hiddenInput) return hiddenInput[2] || hiddenInput[3] || '';

  const jsVar = body.match(/var\s+dle_login_hash\s*=\s*['"]([^'"]+)['"]/i);
  return jsVar ? jsVar[1] : '';
}

function isCsrfTokenExpected(body) {
  return /name=(['"])dle_login_hash\1/i.test(body)
    || /\bdle_login_hash\s*=\s*['"][^'"]+['"]/i.test(body);
}

function requestHtml(host, { path: reqPath, method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path: reqPath,
      method,
      headers,
      rejectUnauthorized: false,
      timeout: AUTH_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const responseBuffer = Buffer.concat(chunks);
        decodeResponseBody(responseBuffer, res.headers['content-encoding'], (decodeErr, decodedBody) => {
          if (decodeErr) return reject(decodeErr);
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: decodedBody,
          });
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      const timeoutErr = new Error(`Request timeout: ${method} ${reqPath}`);
      timeoutErr.code = 'ETIMEDOUT';
      req.destroy(timeoutErr);
    });
    if (body) req.write(body);
    req.end();
  });
}

function decodeResponseBody(buffer, contentEncoding, cb) {
  const encoding = (contentEncoding || '').toLowerCase();
  if (!encoding || encoding === 'identity') return cb(null, buffer.toString('utf8'));
  if (encoding.includes('gzip')) return zlib.gunzip(buffer, (err, out) => cb(err, err ? null : out.toString('utf8')));
  if (encoding.includes('deflate')) return zlib.inflate(buffer, (err, out) => cb(err, err ? null : out.toString('utf8')));
  if (encoding.includes('br')) return zlib.brotliDecompress(buffer, (err, out) => cb(err, err ? null : out.toString('utf8')));
  return cb(null, buffer.toString('utf8'));
}

async function loginToHDRezka(host, login, password, onPhase = () => {}) {
  onPhase('login_get_page');
  const getRes = await requestHtml(host, {
    path: '/',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (SmartTV; WebOS)' },
  });

  if (getRes.statusCode >= 500 || getRes.statusCode === 0) {
    throw createAuthError('mirror_unreachable', `Mirror unavailable on GET / (${getRes.statusCode})`);
  }

  const sessionCookies = extractCookies(getRes.headers);
  const csrfToken = extractCsrfToken(getRes.body);
  const isCsrfExpected = isCsrfTokenExpected(getRes.body);
  if (!csrfToken && isCsrfExpected) throw createAuthError('csrf_missing', 'dle_login_hash declared but not extracted');

  const loginParams = {
    login_name: login,
    login_password: password,
    login_not_save: 0,
  };
  if (csrfToken) loginParams.dle_login_hash = csrfToken;
  const postData = new URLSearchParams(loginParams).toString();

  onPhase('login_post_credentials');
  const postRes = await requestHtml(host, {
    path: '/ajax/login/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
      'Cookie': sessionCookies,
      'User-Agent': 'Mozilla/5.0 (SmartTV; WebOS)',
      'Referer': `https://${host}/`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: postData,
  });

  if (postRes.statusCode >= 500 || postRes.statusCode === 0) {
    throw createAuthError('mirror_unreachable', `Mirror unavailable on POST /ajax/login/ (${postRes.statusCode})`);
  }

  const postCookies = extractCookies(postRes.headers);
  const cookiesAfterPost = mergeCookies(sessionCookies, postCookies);
  const hasAuthAfterPost = hasAuthCookie(cookiesAfterPost);
  const hasRedirect = Boolean(postRes.headers.location) || [301, 302, 303, 307, 308].includes(postRes.statusCode);

  let parsedPostJson = null;
  try {
    parsedPostJson = JSON.parse(postRes.body);
  } catch {
    parsedPostJson = null;
  }

  const isJsonSuccess = parsedPostJson && parsedPostJson.success === true;
  const isRedirectOrNonJsonWithAuth = (hasRedirect || !parsedPostJson) && hasAuthAfterPost;
  if (!isJsonSuccess && !isRedirectOrNonJsonWithAuth) {
    throw createAuthError('login_failed', parsedPostJson?.error || 'Login rejected by mirror');
  }

  onPhase('login_verify_session');
  const verifyRes = await requestHtml(host, {
    path: '/',
    method: 'GET',
    headers: {
      'Cookie': cookiesAfterPost,
      'User-Agent': 'Mozilla/5.0 (SmartTV; WebOS)',
      'Referer': `https://${host}/`,
    },
  });

  if (verifyRes.statusCode >= 500 || verifyRes.statusCode === 0) {
    throw createAuthError('mirror_unreachable', `Mirror unavailable on verify GET / (${verifyRes.statusCode})`);
  }

  const verifyCookies = extractCookies(verifyRes.headers);
  const finalCookies = mergeCookies(cookiesAfterPost, verifyCookies);
  const hasMemberUserId = hasVerifiedMemberUserId(verifyRes.body, finalCookies);
  if (!hasMemberUserId) throw createAuthError('login_failed', 'member_user_id not found after login');

  return finalCookies;
}

app.listen(PORT, () => console.log(`QR Auth server running on port ${PORT}`));
