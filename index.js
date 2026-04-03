'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet  = require('helmet');
const https   = require('https');
const zlib    = require('zlib');
const path    = require('path');
const crypto  = require('crypto');
const net     = require('net');
const { URL } = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '8kb';

app.set('trust proxy', 1); // Trust first proxy (nginx)
app.disable('x-powered-by');

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

function nowIso() {
  return new Date().toISOString();
}

function log(level, event, data = {}) {
  const payload = { ts: nowIso(), level, event, ...data };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

app.use(helmet({
  contentSecurityPolicy: false,
  hsts: false,
  frameguard: false,
  referrerPolicy: false,
}));
app.use(express.json({
  limit: JSON_BODY_LIMIT,
  strict: true,
  type: 'application/json',
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (req.path.startsWith('/session/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use((req, res, next) => {
  const reqIdHeader = (req.headers['x-request-id'] || '').toString().trim();
  const requestId = reqIdHeader || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/session/')) return;
    const ip = getClientIp(req);
    const safeUrl = req.originalUrl.replace(/([?&]t=)[a-f0-9]{8,}/i, '$1***');
    const ua = sanitizeLogValue(req.headers['user-agent'] || '-', 120);
    log('info', 'http.session.request', {
      request_id: requestId,
      method: req.method,
      url: safeUrl,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      ip,
      user_agent: ua,
    });
  });
  next();
});

// Rate limits
const createSessionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // Limit each IP to 5 requests per windowMs
  message: { error: 'rate_limited', error_code: 'rate_limited', message: 'Слишком много попыток создания сессии. Попробуйте позже.' }
});

const submitAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // Max 10 attempts to prevent bruteforce
  message: { success: false, error: 'rate_limited', error_code: 'rate_limited', message: 'Слишком много попыток входа. Попробуйте позже.' }
});

const sessions = {};
const TOKEN_TTL = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = Number.parseInt(process.env.AUTH_TIMEOUT_MS || '10000', 10) || 10000;
const AUTH_ERROR_CODES = new Set(['csrf_missing', 'login_failed', 'mirror_unreachable', 'timeout']);
const LOG_PENDING_CHECKS = process.env.LOG_PENDING_CHECKS === '1';
const MAX_SUBMIT_ATTEMPTS_PER_TOKEN = Number.parseInt(process.env.MAX_SUBMIT_ATTEMPTS_PER_TOKEN || '5', 10) || 5;
const HEALTHCHECK_HOST = process.env.HEALTHCHECK_HOST || process.env.HDREZKA_HOST || 'hdrezka.sb';
const MIRROR_FALLBACKS = (process.env.MIRROR_FALLBACKS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_HOST_KEYWORDS = (process.env.ALLOWED_HOST_KEYWORDS || 'rezka,hdrezka,rezk')
  .split(',')
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_HOST_REGEX_RAW = (process.env.ALLOWED_HOST_REGEX || '').trim();
const BLOCKED_HOST_TLDS = new Set(['local', 'localhost', 'internal', 'test', 'example', 'invalid', 'home', 'lan']);
const MAX_LOGIN_ATTEMPTS_PER_IP_LOGIN = Number.parseInt(process.env.MAX_LOGIN_ATTEMPTS_PER_IP_LOGIN || '10', 10) || 10;
const LOGIN_ATTEMPT_WINDOW_MS = Number.parseInt(process.env.LOGIN_ATTEMPT_WINDOW_MS || String(10 * 60 * 1000), 10) || 10 * 60 * 1000;
const MAX_SUBMIT_FLOW_TIMEOUT_MS = Number.parseInt(process.env.MAX_SUBMIT_FLOW_TIMEOUT_MS || '20000', 10) || 20000;

const ERROR_MESSAGES = {
  csrf_missing: 'Не найден CSRF-токен для входа',
  login_failed: 'Неверный логин или пароль',
  mirror_unreachable: 'Зеркало недоступно',
  timeout: 'Время ожидания истекло',
};

const metrics = {
  startedAtMs: Date.now(),
  authResults: new Map(), // key: host|result
  phaseDurations: new Map(), // key: host|phase => {count,sumMs}
  sessionSubmitTotal: 0,
};
const loginAttemptBuckets = new Map();
const ALLOWED_HOST_REGEX = compileHostRegex(ALLOWED_HOST_REGEX_RAW);

function metricsIncAuthResult(host, result) {
  const key = `${host}|${result}`;
  metrics.authResults.set(key, (metrics.authResults.get(key) || 0) + 1);
}

function metricsObservePhase(host, phase, durationMs) {
  const key = `${host}|${phase}`;
  const prev = metrics.phaseDurations.get(key) || { count: 0, sumMs: 0 };
  prev.count += 1;
  prev.sumMs += Math.max(0, durationMs);
  metrics.phaseDurations.set(key, prev);
}

function escPromLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getClientIp(req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.ip || req.socket.remoteAddress || '-';
}

function sanitizeLogValue(value, maxLen = 160) {
  return String(value || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, maxLen);
}

function makeErrorPayload(code, messageOverride = null) {
  const message = messageOverride || ERROR_MESSAGES[code] || ERROR_MESSAGES.login_failed;
  return {
    success: false,
    error: code,
    error_code: code,
    message,
  };
}

function compileHostRegex(rawPattern) {
  if (!rawPattern) return null;
  try {
    return new RegExp(rawPattern, 'i');
  } catch {
    log('warn', 'config.invalid_allowed_host_regex', { pattern: rawPattern });
    return null;
  }
}

function isAllowedMirror(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  if (net.isIP(normalized)) return false;
  if (normalized === 'localhost' || normalized.endsWith('.local') || normalized.endsWith('.internal')) return false;
  if (!/^[a-z0-9.-]+$/i.test(normalized)) return false;
  if (normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) return false;

  const labels = normalized.split('.').filter(Boolean);
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  if (BLOCKED_HOST_TLDS.has(tld)) return false;

  if (ALLOWED_HOST_REGEX && ALLOWED_HOST_REGEX.test(normalized)) return true;
  if (!ALLOWED_HOST_KEYWORDS.length) return true;
  return ALLOWED_HOST_KEYWORDS.some(k => normalized.includes(k));
}

function cleanupAttemptBucket(entry, now) {
  const threshold = now - LOGIN_ATTEMPT_WINDOW_MS;
  while (entry.failures.length && entry.failures[0] < threshold) entry.failures.shift();
}

function getAttemptKey(ip, login) {
  return `${sanitizeLogValue(ip, 80)}|${sanitizeLogValue(login, 120).toLowerCase()}`;
}

function isLoginThrottled(ip, login) {
  const key = getAttemptKey(ip, login);
  const now = Date.now();
  const entry = loginAttemptBuckets.get(key);
  if (!entry) return false;
  cleanupAttemptBucket(entry, now);
  if (!entry.failures.length) {
    loginAttemptBuckets.delete(key);
    return false;
  }
  return entry.failures.length >= MAX_LOGIN_ATTEMPTS_PER_IP_LOGIN;
}

function recordLoginFailure(ip, login) {
  const key = getAttemptKey(ip, login);
  const now = Date.now();
  const entry = loginAttemptBuckets.get(key) || { failures: [] };
  cleanupAttemptBucket(entry, now);
  entry.failures.push(now);
  loginAttemptBuckets.set(key, entry);
}

function clearLoginFailures(ip, login) {
  const key = getAttemptKey(ip, login);
  loginAttemptBuckets.delete(key);
}

function hasUnsafeInputChars(value) {
  const text = String(value || '');
  if (/[\r\n\t]/.test(text)) return true;
  try {
    return /[\p{Cc}\p{Cf}]/u.test(text);
  } catch {
    return false;
  }
}

function isValidToken(token) {
  return /^[a-f0-9]{32}$/i.test(String(token || ''));
}

function uniqueMirrors(primaryHost) {
  const hosts = [primaryHost, ...MIRROR_FALLBACKS].map(normalizeHost).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const h of hosts) {
    const normalized = h.toLowerCase();
    if (!isAllowedMirror(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

setInterval(() => {
  const now = Date.now();
  for (const token in sessions) {
    if (now - sessions[token].createdAt > TOKEN_TTL) {
      log('info', 'session.timeout', { token: `${token.slice(0, 8)}...`, host: sessions[token].host });
      delete sessions[token];
    }
  }
}, 60_000);

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttemptBuckets.entries()) {
    cleanupAttemptBucket(entry, now);
    if (!entry.failures.length) loginAttemptBuckets.delete(key);
  }
}, 60_000);

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json(makeErrorPayload('login_failed', 'Слишком большой размер запроса'));
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json(makeErrorPayload('login_failed', 'Некорректный JSON в запросе'));
  }
  return next(err);
});

app.get('/health/live', (_req, res) => {
  res.json({ ok: true, status: 'live', ts: nowIso() });
});

app.get('/health/ready', async (_req, res) => {
  try {
    const checkRes = await requestHtml(HEALTHCHECK_HOST, {
      path: '/',
      method: 'GET',
      headers: { 'User-Agent': 'RezkaTV-QR/healthcheck' },
      timeoutMs: 3000,
    });
    const isReady = checkRes.statusCode > 0 && checkRes.statusCode < 500;
    const payload = { ok: isReady, status: isReady ? 'ready' : 'degraded', host: HEALTHCHECK_HOST, status_code: checkRes.statusCode };
    return res.status(isReady ? 200 : 503).json(payload);
  } catch (err) {
    const code = normalizeAuthError(err);
    return res.status(503).json({ ok: false, status: 'degraded', host: HEALTHCHECK_HOST, error_code: code, message: ERROR_MESSAGES[code] || 'Зеркало недоступно' });
  }
});

app.get('/metrics', (_req, res) => {
  const lines = [];
  lines.push('# HELP rezkatv_qr_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE rezkatv_qr_uptime_seconds gauge');
  lines.push(`rezkatv_qr_uptime_seconds ${Math.floor((Date.now() - metrics.startedAtMs) / 1000)}`);
  lines.push('# HELP rezkatv_qr_session_submit_total Total submit attempts');
  lines.push('# TYPE rezkatv_qr_session_submit_total counter');
  lines.push(`rezkatv_qr_session_submit_total ${metrics.sessionSubmitTotal}`);

  lines.push('# HELP rezkatv_qr_auth_result_total Auth results by host and result');
  lines.push('# TYPE rezkatv_qr_auth_result_total counter');
  for (const [key, count] of metrics.authResults.entries()) {
    const [host, result] = key.split('|');
    lines.push(`rezkatv_qr_auth_result_total{host="${escPromLabel(host)}",result="${escPromLabel(result)}"} ${count}`);
  }

  lines.push('# HELP rezkatv_qr_auth_phase_duration_ms_sum Total duration by auth phase');
  lines.push('# TYPE rezkatv_qr_auth_phase_duration_ms_sum counter');
  lines.push('# HELP rezkatv_qr_auth_phase_duration_ms_count Count by auth phase');
  lines.push('# TYPE rezkatv_qr_auth_phase_duration_ms_count counter');
  for (const [key, stat] of metrics.phaseDurations.entries()) {
    const [host, phase] = key.split('|');
    lines.push(`rezkatv_qr_auth_phase_duration_ms_sum{host="${escPromLabel(host)}",phase="${escPromLabel(phase)}"} ${stat.sumMs}`);
    lines.push(`rezkatv_qr_auth_phase_duration_ms_count{host="${escPromLabel(host)}",phase="${escPromLabel(phase)}"} ${stat.count}`);
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

app.post('/session/create', createSessionLimiter, (req, res) => {
  if (Object.keys(sessions).length >= 100) {
    return res.status(429).json({ error: 'overloaded', error_code: 'overloaded', message: 'Сервер временно перегружен сессиями. Попробуйте позже.' });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const host  = normalizeHost(req.body.host || process.env.HDREZKA_HOST || 'hdrezka.ag');
  if (!host) {
    return res.status(400).json({ error: 'invalid_host', error_code: 'invalid_host', message: 'Некорректный host' });
  }
  if (!isAllowedMirror(host)) {
    return res.status(400).json({ error: 'invalid_host', error_code: 'invalid_host', message: 'Host не разрешен политикой безопасности' });
  }
  sessions[token] = { status: 'pending', phase: 'idle', host, createdAt: Date.now(), submitAttempts: 0, inFlight: false };
  log('info', 'session.created', { token: `${token.slice(0, 8)}...`, host, request_id: req.requestId });
  res.json({ token });
});

app.get('/session/check', (req, res) => {
  const token = (req.query.t || '').toString();
  if (!isValidToken(token)) return res.json({ status: 'expired' });
  const session = sessions[token];
  if (!session) {
    log('warn', 'session.check.expired', { token: `${token.slice(0, 8)}...`, request_id: req.requestId });
    return res.json({ status: 'expired' });
  }
  if (session.status === 'done') {
    const { cookies, host, phase } = session;
    delete sessions[token];
    log('info', 'session.check.done', { token: `${token.slice(0, 8)}...`, host, phase, request_id: req.requestId });
    return res.json({ status: 'done', cookies, host, phase });
  }
  if (session.status === 'error') {
    log('warn', 'session.check.error', {
      token: `${token.slice(0, 8)}...`,
      host: session.host,
      phase: session.phase || 'unknown',
      error_code: session.error,
      request_id: req.requestId,
    });
    return res.json({
      status: 'error',
      error: session.error,
      error_code: session.error,
      message: ERROR_MESSAGES[session.error] || ERROR_MESSAGES.login_failed,
      host: session.host,
      phase: session.phase || 'unknown',
    });
  }
  if (LOG_PENDING_CHECKS) {
    log('info', 'session.check.pending', { token: `${token.slice(0, 8)}...`, host: session.host, phase: session.phase || 'unknown', request_id: req.requestId });
  }
  res.json({ status: 'pending', host: session.host, phase: session.phase || 'unknown' });
});

app.post('/session/submit', submitAuthLimiter, async (req, res) => {
  const { token, login, password } = req.body;
  const loginValue = String(login || '').trim();
  const passwordValue = String(password || '');
  const clientIp = getClientIp(req);
  metrics.sessionSubmitTotal += 1;
  log('info', 'auth.submit.received', {
    request_id: req.requestId,
    token: (token || '').toString().slice(0, 8) + '...',
    login_present: Boolean(loginValue),
    password_present: Boolean(passwordValue),
  });
  if (!token || !loginValue || !passwordValue) {
    log('warn', 'auth.submit.rejected', {
      request_id: req.requestId,
      reason: 'missing_fields',
      token: (token || '').toString().slice(0, 8) + '...',
    });
    return res.status(400).json(makeErrorPayload('login_failed', 'Не все поля заполнены'));
  }
  if (!isValidToken(token)) {
    return res.status(400).json(makeErrorPayload('login_failed', 'Некорректный токен сессии'));
  }
  if (loginValue.length > 256 || passwordValue.length > 256) {
    return res.status(400).json(makeErrorPayload('login_failed', 'Некорректная длина логина или пароля'));
  }
  if (hasUnsafeInputChars(loginValue)) {
    return res.status(400).json(makeErrorPayload('login_failed', 'Логин содержит недопустимые символы'));
  }
  if (isLoginThrottled(clientIp, loginValue)) {
    log('warn', 'auth.submit.rejected', {
      request_id: req.requestId,
      reason: 'ip_login_throttled',
      token: token.slice(0, 8) + '...',
      host: sessions[token]?.host || 'unknown',
      ip: sanitizeLogValue(clientIp, 80),
      login: maskLogin(loginValue),
    });
    return res.status(429).json(makeErrorPayload('login_failed', 'Слишком много попыток входа. Попробуйте позже.'));
  }

  const session = sessions[token];
  if (!session) {
    log('warn', 'auth.submit.rejected', {
      request_id: req.requestId,
      reason: 'session_expired',
      token: token.slice(0, 8) + '...',
    });
    return res.status(400).json(makeErrorPayload('login_failed', 'QR-код истёк, обновите его на телевизоре'));
  }

  if (session.status !== 'pending') {
    log('warn', 'auth.submit.rejected', {
      request_id: req.requestId,
      reason: 'token_already_used',
      token: token.slice(0, 8) + '...',
      status: session.status,
      host: session.host,
    });
    return res.status(409).json(makeErrorPayload('login_failed', 'Сессия уже завершена, обновите QR-код'));
  }

  if (session.inFlight) {
    log('warn', 'auth.submit.rejected', {
      request_id: req.requestId,
      reason: 'auth_in_progress',
      token: token.slice(0, 8) + '...',
      host: session.host,
    });
    return res.status(409).json(makeErrorPayload('login_failed', 'Авторизация уже выполняется'));
  }

  if ((session.submitAttempts || 0) >= MAX_SUBMIT_ATTEMPTS_PER_TOKEN) {
    updateSession(token, { status: 'error', error: 'login_failed', phase: 'submit_rate_limited' });
    metricsIncAuthResult(session.host, 'too_many_attempts');
    log('warn', 'auth.submit.rejected', {
      request_id: req.requestId,
      reason: 'too_many_attempts',
      token: token.slice(0, 8) + '...',
      host: session.host,
      submit_attempts: session.submitAttempts,
    });
    return res.status(429).json(makeErrorPayload('login_failed', 'Слишком много попыток для этого QR-кода'));
  }

  updateSession(token, { submitAttempts: (session.submitAttempts || 0) + 1, inFlight: true });

  const phaseStartByName = new Map();
  const markPhase = (phase, host) => {
    phaseStartByName.set(phase, { t: Date.now(), host });
    updateSession(token, { phase });
    log('info', 'auth.phase', { request_id: req.requestId, token: token.slice(0, 8) + '...', host, phase });
  };
  const closePhase = (phase) => {
    const entry = phaseStartByName.get(phase);
    if (!entry) return;
    metricsObservePhase(entry.host, phase, Date.now() - entry.t);
    phaseStartByName.delete(phase);
  };

  const mirrors = uniqueMirrors(session.host);
  let lastErr = null;
  let authenticatedHost = session.host;
  const deadlineAt = Date.now() + MAX_SUBMIT_FLOW_TIMEOUT_MS;
  try {
    let cookies = '';
    for (let i = 0; i < mirrors.length; i += 1) {
      if (Date.now() >= deadlineAt) throw createAuthError('timeout', 'Submit flow timeout exceeded');
      const host = mirrors[i];
      updateSession(token, { status: 'pending', phase: 'login_get_page', error: null, host });
      log('info', 'auth.attempt.start', {
        request_id: req.requestId,
        token: token.slice(0, 8) + '...',
        host,
        mirror_try: i + 1,
        mirror_total: mirrors.length,
        login: maskLogin(login),
      });

      try {
        cookies = await loginToHDRezka(host, loginValue, passwordValue, (phase) => {
          markPhase(phase, host);
        }, deadlineAt);
        authenticatedHost = host;
        closePhase('login_get_page');
        closePhase('login_post_credentials');
        closePhase('login_verify_session');
        break;
      } catch (err) {
        closePhase('login_get_page');
        closePhase('login_post_credentials');
        closePhase('login_verify_session');
        lastErr = err;
        const code = normalizeAuthError(err);
        metricsIncAuthResult(host, code);
        log('warn', 'auth.attempt.failed', {
          request_id: req.requestId,
          token: token.slice(0, 8) + '...',
          host,
          mirror_try: i + 1,
          mirror_total: mirrors.length,
          error_code: code,
          detail: err.message,
        });
        if ((code === 'timeout' || code === 'mirror_unreachable') && i < mirrors.length - 1) {
          continue;
        }
        throw err;
      }
    }

    if (!cookies) throw (lastErr || createAuthError('login_failed', 'No cookies after login'));
    metricsIncAuthResult(authenticatedHost, 'success');
    updateSession(token, { status: 'done', phase: 'done', cookies, error: null, host: authenticatedHost, inFlight: false });
    clearLoginFailures(clientIp, loginValue);
    log('info', 'auth.success', {
      request_id: req.requestId,
      token: token.slice(0, 8) + '...',
      host: authenticatedHost,
      login: maskLogin(loginValue),
    });
    res.json({ success: true, host: authenticatedHost, phase: 'done' });
  } catch (err) {
    const code = normalizeAuthError(err);
    const currentHost = sessions[token]?.host || session.host;
    updateSession(token, { status: 'error', error: code, phase: sessions[token]?.phase || 'unknown', inFlight: false, host: currentHost });
    metricsIncAuthResult(currentHost, code);
    if (code === 'login_failed') recordLoginFailure(clientIp, loginValue);
    log('error', 'auth.error', {
      request_id: req.requestId,
      token: token.slice(0, 8) + '...',
      login: maskLogin(loginValue),
      host: currentHost,
      phase: sessions[token]?.phase || 'unknown',
      error_code: code,
      detail: err.message,
      syscode: err.code || 'n/a',
    });
    res.json({ ...makeErrorPayload(code), host: currentHost, phase: sessions[token]?.phase || 'unknown' });
  }
});

app.get('/auth', (req, res) => {
  if (!isValidToken(req.query.t) || !sessions[req.query.t])
    return res.status(400).send('QR-код истёк или недействителен. Обновите его на телевизоре.');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

function updateSession(token, patch) {
  if (!sessions[token]) return;
  sessions[token] = { ...sessions[token], ...patch };
}

function normalizeHost(inputHost) {
  if (!inputHost || typeof inputHost !== 'string') return '';
  const trimmed = inputHost.trim();
  if (!trimmed) return '';
  try {
    if (trimmed.includes('://')) return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return '';
  }
  return trimmed.replace(/\/+$/, '').toLowerCase();
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

function requestHtml(host, { path: reqPath, method = 'GET', headers = {}, body = '', timeoutMs = AUTH_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path: reqPath,
      method,
      headers,
      rejectUnauthorized: false,
      timeout: timeoutMs,
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

function getRemainingTimeoutMs(deadlineAt) {
  if (!deadlineAt) return AUTH_TIMEOUT_MS;
  return Math.max(1, Math.min(AUTH_TIMEOUT_MS, deadlineAt - Date.now()));
}

async function loginToHDRezka(host, login, password, onPhase = () => {}, deadlineAt = 0) {
  onPhase('login_get_page');
  const getRes = await requestHtml(host, {
    path: '/',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (SmartTV; WebOS)' },
    timeoutMs: getRemainingTimeoutMs(deadlineAt),
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
    timeoutMs: getRemainingTimeoutMs(deadlineAt),
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
    timeoutMs: getRemainingTimeoutMs(deadlineAt),
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

app.listen(PORT, () => log('info', 'server.started', { port: PORT }));
