#!/bin/sh
# Smart certificate renewal script
# - Runs every 15 days via cron
# - On failure: sets retry flag for cert-retry.sh
# - Logs to stdout (captured by cron)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="/tmp/cert-renew.lock"
RETRY_FLAG="/tmp/cert-renew-retry"
LOG_PREFIX="[cert-renew]"

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

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(cat "$LOCK_FILE")
    if kill -0 "$LOCK_PID" 2>/dev/null; then
        log "Another renewal process is running (PID: $LOCK_PID), exiting"
        exit 0
    fi
    rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Attempt production certificate renewal
log "Starting certificate renewal check"

if docker run --rm \
    -v "$CERTBOT_WWW:/var/www/certbot" \
    -v "$CERTBOT_CONF:/etc/letsencrypt" \
    "$CERTBOT_IMAGE" renew --webroot -w /var/www/certbot 2>&1; then

    log "Production renewal succeeded"
    docker compose -f "$PROJECT_DIR/docker-compose.yml" restart nginx
    log "Nginx restarted with new certificate"
    rm -f "$RETRY_FLAG"
    exit 0
fi

# Production failed — set retry flag
log "Production renewal failed, enabling retry mode (every 4 hours)"
date '+%s' > "$RETRY_FLAG"
exit 1
