'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const https   = require('https');
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
  sessions[token] = { status: 'pending', host, createdAt: Date.now() };
  console.log(`[Session] Created token: ${token.slice(0, 8)}... for host: ${host}`);
  res.json({ token });
});

app.get('/session/check', (req, res) => {
  const session = sessions[req.query.t];
  if (!session) return res.json({ status: 'expired' });
  if (session.status === 'done') {
    const { cookies } = session;
    delete sessions[req.query.t];
    console.log(`[Session] Handed over cookies for token: ${req.query.t.slice(0, 8)}...`);
    return res.json({ status: 'done', cookies });
  }
  if (session.status === 'error') return res.json({ status: 'error', error: session.error });
  res.json({ status: 'pending' });
});

app.post('/session/submit', submitAuthLimiter, async (req, res) => {
  const { token, login, password } = req.body;
  if (!token || !login || !password)
    return res.status(400).json({ success: false, error: 'Не все поля заполнены' });

  const session = sessions[token];
  if (!session)
    return res.status(400).json({ success: false, error: 'QR-код истёк, обновите его на телевизоре' });

  try {
    console.log(`[Auth] Attempting login for ${maskLogin(login)} on ${session.host} (token: ${token.slice(0, 8)}...)`);
    const cookies = await loginToHDRezka(session.host, login, password);
    sessions[token] = { ...session, status: 'done', cookies };
    console.log(`[Auth] Success for ${maskLogin(login)} (token: ${token.slice(0, 8)}...)`);
    res.json({ success: true });
  } catch (err) {
    sessions[token] = { ...session, status: 'error', error: err.message };
    console.error(`[Auth] Error for ${maskLogin(login)}: ${err.message} (token: ${token.slice(0, 8)}...)`);
    res.json({ success: false, error: err.message });
  }
});

app.get('/auth', (req, res) => {
  if (!req.query.t || !sessions[req.query.t])
    return res.status(400).send('QR-код истёк или недействителен. Обновите его на телевизоре.');
  res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

function loginToHDRezka(host, login, password) {
  return new Promise((resolve, reject) => {
    const getReq = https.request({
      hostname: host,
      path:     '/',
      method:   'GET',
      headers:  { 'User-Agent': 'Mozilla/5.0 (SmartTV; WebOS)' },
      rejectUnauthorized: false,
      timeout: 10000,
    }, (getRes) => {
      const sessionCookies = (getRes.headers['set-cookie'] || [])
        .map(c => c.split(';')[0]).join('; ');

      let body = '';
      getRes.on('data', chunk => body += chunk);
      getRes.on('end', () => {
        const match     = body.match(/name="dle_login_hash"\s+value="([^"]+)"/);
        const csrfToken = match ? match[1] : '';

        const postData = new URLSearchParams({
          login_name:     login,
          login_password: password,
          login_not_save: 0,
          dle_login_hash: csrfToken,
        }).toString();

        const postReq = https.request({
          hostname: host,
          path:     '/ajax/login/',
          method:   'POST',
          headers: {
            'Content-Type':     'application/x-www-form-urlencoded',
            'Content-Length':   Buffer.byteLength(postData),
            'Cookie':           sessionCookies,
            'User-Agent':       'Mozilla/5.0 (SmartTV; WebOS)',
            'Referer':          `https://${host}/`,
            'X-Requested-With': 'XMLHttpRequest',
          },
          rejectUnauthorized: false,
          timeout: 10000,
        }, (postRes) => {
          let respBody = '';
          postRes.on('data', chunk => respBody += chunk);
          postRes.on('end', () => {
            try {
              const json = JSON.parse(respBody);
              if (json.success) {
                const newCookies = (postRes.headers['set-cookie'] || [])
                  .map(c => c.split(';')[0]).join('; ');
                resolve([sessionCookies, newCookies].filter(Boolean).join('; '));
              } else {
                reject(new Error(json.error || 'Неверный логин или пароль'));
              }
            } catch {
              reject(new Error('Ошибка ответа от HDRezka'));
            }
          });
        });

        postReq.on('error', err => reject(err));
        postReq.on('timeout', () => {
          postReq.destroy();
          reject(new Error('Время ожидания ответа от HDRezka (POST) истекло'));
        });
        postReq.write(postData);
        postReq.end();
      });
    });

    getReq.on('error', err => reject(err));
    getReq.on('timeout', () => {
      getReq.destroy();
      reject(new Error('Время ожидания ответа от HDRezka (GET) истекло'));
    });
    getReq.end();
  });
}

app.listen(PORT, () => console.log(`QR Auth server running on port ${PORT}`));