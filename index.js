'use strict';

const express = require('express');
const https   = require('https');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};
const TOKEN_TTL = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const token in sessions) {
    if (now - sessions[token].createdAt > TOKEN_TTL) delete sessions[token];
  }
}, 60_000);

app.post('/session/create', (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  const host  = req.body.host || process.env.HDREZKA_HOST || 'hdrezka.ag';
  sessions[token] = { status: 'pending', host, createdAt: Date.now() };
  res.json({ token });
});

app.get('/session/check', (req, res) => {
  const session = sessions[req.query.t];
  if (!session) return res.json({ status: 'expired' });
  if (session.status === 'done') {
    const { cookies } = session;
    delete sessions[req.query.t];
    return res.json({ status: 'done', cookies });
  }
  if (session.status === 'error') return res.json({ status: 'error', error: session.error });
  res.json({ status: 'pending' });
});

app.post('/session/submit', async (req, res) => {
  const { token, login, password } = req.body;
  if (!token || !login || !password)
    return res.status(400).json({ success: false, error: 'Не все поля заполнены' });

  const session = sessions[token];
  if (!session)
    return res.status(400).json({ success: false, error: 'QR-код истёк, обновите его на телевизоре' });

  try {
    const cookies = await loginToHDRezka(session.host, login, password);
    sessions[token] = { ...session, status: 'done', cookies };
    res.json({ success: true });
  } catch (err) {
    sessions[token] = { ...session, status: 'error', error: err.message };
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
        postReq.write(postData);
        postReq.end();
      });
    });

    getReq.on('error', err => reject(err));
    getReq.end();
  });
}

app.listen(PORT, () => console.log(`QR Auth server running on port ${PORT}`));