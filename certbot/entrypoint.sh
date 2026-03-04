#!/bin/sh
set -e

CERT_DIR=/etc/letsencrypt/live/${DOMAIN}
CERTBOT_EMAIL=${CERTBOT_EMAIL:-}
STAGING=${STAGING:-0}

# Wait for nginx to be ready
echo "Waiting for nginx..."
sleep 5

# Check if certificate exists
if [ -d "$CERT_DIR" ]; then
  echo "Certificate already exists. Starting renewal loop..."
else
  echo "No certificate found. Requesting new one..."
  
  STAGING_FLAG=""
  if [ "$STAGING" = "1" ]; then
    STAGING_FLAG="--staging"
    echo "Using STAGING environment (test certificate)"
  fi
  
  if [ -z "$CERTBOT_EMAIL" ]; then
    echo "ERROR: CERTBOT_EMAIL is required for new certificate"
    exit 1
  fi
  
  certbot certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    -d $DOMAIN \
    --email $CERTBOT_EMAIL \
    --agree-tos \
    --no-eff-email \
    $STAGING_FLAG
  
  echo "Certificate obtained!"
fi

# Start renewal loop
echo "Starting certificate renewal loop..."
trap exit TERM
while :; do
  certbot renew --webroot -w /var/www/certbot --quiet
  sleep 12h &
  wait $!
done