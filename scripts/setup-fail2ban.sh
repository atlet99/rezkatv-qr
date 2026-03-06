#!/bin/bash
set -e

echo "=== Fail2ban configuration ==="
echo ""

# Auto-detect SSH port
SSH_PORT=$(ss -tlnp | grep sshd | awk '{print $4}' | cut -d: -f2 | head -1)
if [ -z "$SSH_PORT" ]; then
    SSH_PORT=$(grep -E "^Port " /etc/ssh/sshd_config | awk '{print $2}' | head -1)
fi
if [ -z "$SSH_PORT" ]; then
    SSH_PORT=22
fi

# Auto-detect nginx log path
NGINX_ERROR_LOG=""
NGINX_ACCESS_LOG=""
for path in /var/log/nginx/error.log /var/log/docker/nginx/error.log; do
    if [ -f "$path" ]; then
        NGINX_ERROR_LOG="$path"
        break
    fi
done
for path in /var/log/nginx/access.log /var/log/docker/nginx/access.log; do
    if [ -f "$path" ]; then
        NGINX_ACCESS_LOG="$path"
        break
    fi
done

# Auto-detect traefik log path
TRAEFIK_LOG=""
for path in /var/log/traefik/access.log /var/log/docker/traefik/access.log; do
    if [ -f "$path" ]; then
        TRAEFIK_LOG="$path"
        break
    fi
done

# Create log files if missing
if [ -z "$NGINX_ERROR_LOG" ]; then
    mkdir -p /var/log/nginx
    touch /var/log/nginx/error.log
    NGINX_ERROR_LOG="/var/log/nginx/error.log"
    echo "Created: $NGINX_ERROR_LOG"
fi
if [ -z "$NGINX_ACCESS_LOG" ]; then
    mkdir -p /var/log/nginx
    touch /var/log/nginx/access.log
    NGINX_ACCESS_LOG="/var/log/nginx/access.log"
    echo "Created: $NGINX_ACCESS_LOG"
fi
if [ -z "$TRAEFIK_LOG" ]; then
    mkdir -p /var/log/traefik
    touch /var/log/traefik/access.log
    TRAEFIK_LOG="/var/log/traefik/access.log"
    echo "Created: $TRAEFIK_LOG"
fi

echo "Detected SSH port:        $SSH_PORT"
echo "Detected nginx error log: $NGINX_ERROR_LOG"
echo "Detected nginx access log: $NGINX_ACCESS_LOG"
echo "Detected traefik log:     $TRAEFIK_LOG"
echo ""

# Confirm
read -r -p "Apply fail2ban config? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
fi

# fail2ban.local — fix allowipv6 warning
if [ ! -f /etc/fail2ban/fail2ban.local ]; then
    cp /etc/fail2ban/fail2ban.conf /etc/fail2ban/fail2ban.local
fi
sed -i 's/#allowipv6 = auto/allowipv6 = auto/' /etc/fail2ban/fail2ban.local

# Write jail config
cat > /etc/fail2ban/jail.d/custom.local << EOF
[DEFAULT]
allowipv6 = auto
ignoreip = 127.0.0.1/8 ::1
bantime  = 1h
findtime = 10m
maxretry = 5

banaction = ufw
banaction_allports = ufw

bantime.increment = true
bantime.maxtime = 1w
bantime.factor = 1

[sshd]
enabled  = true
port     = ${SSH_PORT}
mode     = aggressive
maxretry = 3
bantime  = 24h
backend  = systemd

[nginx-http-auth]
enabled  = true
port     = http,https
logpath  = ${NGINX_ERROR_LOG}

[nginx-botsearch]
enabled  = true
port     = http,https
logpath  = ${NGINX_ERROR_LOG}
maxretry = 2

[nginx-bad-request]
enabled  = true
port     = http,https
logpath  = ${NGINX_ACCESS_LOG}
maxretry = 10

[traefik-auth]
enabled  = true
port     = http,https
logpath  = ${TRAEFIK_LOG}
maxretry = 5

[recidive]
enabled  = true
logpath  = /var/log/fail2ban.log
bantime  = 1w
findtime = 1d
maxretry = 3
EOF

echo ""
echo "Testing config..."
fail2ban-client -t

echo ""
echo "Restarting fail2ban..."
systemctl restart fail2ban

echo ""
echo "=== Jail status ==="
fail2ban-client status