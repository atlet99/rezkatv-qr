#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3399}"
HOST="${HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"

echo "[smoke] starting app on ${BASE}"
PORT="$PORT" node index.js >/tmp/rezkatv-qr-smoke-script.log 2>&1 &
PID=$!
cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
  wait "$PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sleep 1

echo "[smoke] health/live"
curl -fsS "${BASE}/health/live"
echo

echo "[smoke] health/ready"
curl -fsS "${BASE}/health/ready"
echo

echo "[smoke] metrics (first 20 lines)"
curl -fsS "${BASE}/metrics" | sed -n '1,20p'

echo "[smoke] invalid login flow"
TOKEN="$(curl -fsS -X POST "${BASE}/session/create" -H 'content-type: application/json' -d '{"host":"hdrezka.sb"}' | node -pe "JSON.parse(fs.readFileSync(0,'utf8')).token")"
curl -fsS -X POST "${BASE}/session/submit" -H 'content-type: application/json' \
  -d "{\"token\":\"${TOKEN}\",\"login\":\"invalid_login\",\"password\":\"invalid_password\"}"
echo
curl -fsS "${BASE}/session/check?t=${TOKEN}"
echo

if [[ -n "${REZKATV_USERNAME:-}" && -n "${REZKATV_PASSWORD:-}" ]]; then
  echo "[smoke] success login flow with REZKATV_USERNAME/REZKATV_PASSWORD"
  TOKEN="$(curl -fsS -X POST "${BASE}/session/create" -H 'content-type: application/json' -d '{"host":"hdrezka.sb"}' | node -pe "JSON.parse(fs.readFileSync(0,'utf8')).token")"
  curl -fsS -X POST "${BASE}/session/submit" -H 'content-type: application/json' \
    -d "{\"token\":\"${TOKEN}\",\"login\":\"${REZKATV_USERNAME}\",\"password\":\"${REZKATV_PASSWORD}\"}"
  echo
  curl -fsS "${BASE}/session/check?t=${TOKEN}"
  echo
fi

echo "[smoke] done"
