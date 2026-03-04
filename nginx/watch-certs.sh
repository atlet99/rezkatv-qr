#!/bin/sh
# Watch for certificate changes and reload nginx

CERT_DIR="/etc/letsencrypt/live"

# Run in background
(
  echo "Starting certificate watcher..."
  while inotifywait -q -e modify,create,delete "$CERT_DIR" 2>/dev/null; do
    echo "Certificate change detected, reloading nginx..."
    nginx -s reload
  done
) &