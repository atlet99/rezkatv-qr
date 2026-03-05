#!/bin/sh
# Retry script — runs every 4 hours when renewal has failed
# Checks staging first, then attempts production if staging is OK

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RETRY_FLAG="/tmp/cert-renew-retry"
LOG_PREFIX="[cert-retry]"

# Load environment
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$PROJECT_DIR/.env"
    set +a
fi

CERTBOT_IMAGE="${CERTBOT_IMAGE:-certbot/certbot:v5.3.1}"
CERTBOT_WWW="$PROJECT_DIR/certbot/www"
CERTBOT_CONF="$PROJECT_DIR/certbot/conf"

log() {
    echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $1"
}

# Only run if retry flag exists (previous renewal failed)
if [ ! -f "$RETRY_FLAG" ]; then
    exit 0
fi

log "Retry flag found, checking Let's Encrypt availability..."

# Step 1: Validate via staging dry-run
if ! docker run --rm \
    -v "$CERTBOT_WWW:/var/www/certbot" \
    -v "$CERTBOT_CONF:/etc/letsencrypt" \
    "$CERTBOT_IMAGE" \
    certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" -m "$CERTBOT_EMAIL" \
    --agree-tos -n --test-cert --dry-run 2>&1; then
    log "Staging still failing, will retry in 4 hours"
    exit 1
fi

log "Staging OK! Attempting production renewal..."

# Step 2: Production renewal
if docker run --rm \
    -v "$CERTBOT_WWW:/var/www/certbot" \
    -v "$CERTBOT_CONF:/etc/letsencrypt" \
    "$CERTBOT_IMAGE" \
    renew --webroot -w /var/www/certbot 2>&1; then
    log "Production renewal succeeded!"
    docker compose -f "$PROJECT_DIR/docker-compose.yml" restart nginx
    log "Nginx restarted with new certificate"
    rm -f "$RETRY_FLAG"
    exit 0
fi

log "Production still failing despite staging success, will retry in 4 hours"
exit 1
