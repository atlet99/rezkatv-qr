#!/bin/sh
set -e

CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"

if [ -f "$CERT_PATH" ]; then
    echo "SSL certificate found, enabling HTTPS configuration"
    cp /etc/nginx/templates-source/ssl.conf.template /etc/nginx/templates/default.conf.template
else
    echo "SSL certificate not found, using HTTP-only configuration"
    cp /etc/nginx/templates-source/nossl.conf.template /etc/nginx/templates/default.conf.template
fi

# Run the default nginx entrypoint
exec /docker-entrypoint.sh "$@"
