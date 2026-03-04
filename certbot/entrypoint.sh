#!/bin/sh
set -e

CERT_DIR=/etc/letsencrypt/live/${DOMAIN}
CERTBOT_EMAIL=${CERTBOT_EMAIL:-}
STAGING=${STAGING:-0}

reload_nginx() {
  echo "Reloading nginx..."
  curl -X POST --unix-socket /var/run/docker.sock \
    "http://localhost/containers/qr-auth-nginx/exec" \
    -H "Content-Type: application/json" \
    -d '{"Cmd": ["nginx", "-s", "reload"], "AttachStdout": true, "AttachStderr": true}' \
    2>/dev/null || echo "Note: Reload nginx manually: docker compose exec nginx nginx -s reload"
}

# Wait for nginx to be ready
echo "Waiting for nginx..."
sleep 5

# Check if certificate exists
if [ -d "$CERT_DIR" ]; then
  echo "Certificate already exists. Starting renewal loop..."
else
  echo "No certificate found. Requesting new one..."
  
  TEST_CERT_FLAG=""
  if [ "$STAGING" = "1" ]; then
    TEST_CERT_FLAG="--test-cert"
    echo "Using test certificate (staging)"
  fi
  
  if [ -z "$CERTBOT_EMAIL" ]; then
    echo "ERROR: CERTBOT_EMAIL is required for new certificate"
    exit 1
  fi
  
  if certbot certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    -d $DOMAIN \
    -m $CERTBOT_EMAIL \
    --agree-tos \
    -n \
    $TEST_CERT_FLAG; then
    echo "Certificate obtained!"
    reload_nginx
  else
    echo "Failed to obtain certificate"
    exit 1
  fi
fi

# Start renewal loop
echo "Starting certificate renewal loop..."
trap exit TERM
while :; do
  if certbot renew --webroot -w /var/www/certbot --quiet; then
    reload_nginx
  fi
  sleep 12h &
  wait $!
done