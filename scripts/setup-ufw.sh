#!/bin/bash
set -e

# Auto-detect SSH port
SSH_PORT=$(ss -tlnp | grep sshd | awk '{print $4}' | cut -d: -f2 | head -1)
if [ -z "$SSH_PORT" ]; then
    SSH_PORT=$(grep -E "^Port " /etc/ssh/sshd_config | awk '{print $2}' | head -1)
fi
if [ -z "$SSH_PORT" ]; then
    SSH_PORT=22
fi

# Auto-detect default network interface
DEFAULT_IFACE=$(ip route show default | awk '/default/ {print $5}' | head -1)
if [ -z "$DEFAULT_IFACE" ]; then
    DEFAULT_IFACE=$(ip link show | awk -F: '$0 !~ "lo|vir|docker|br-|veth|^[^0-9]"{print $2;exit}' | tr -d ' ')
fi

# Auto-detect Docker bridge subnet
DOCKER_SUBNET=$(docker network ls -q | xargs docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null | grep -v '^$' | grep -v '172.17' | head -1)
if [ -z "$DOCKER_SUBNET" ]; then
    DOCKER_SUBNET=$(ip route | grep br- | awk '{print $1}' | head -1)
fi

echo "Detected SSH port:      $SSH_PORT"
echo "Detected interface:     $DEFAULT_IFACE"
echo "Detected Docker subnet: $DOCKER_SUBNET"
echo ""

# Confirm before applying
read -r -p "Apply UFW rules? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
fi

# Reset
ufw --force reset

# Default policies
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed

# SSH
ufw limit "${SSH_PORT}"/tcp

# HTTP / HTTPS
ufw allow 80/tcp
ufw allow 443/tcp

# Allow Docker bridge forwarding
if [ -n "$DOCKER_SUBNET" ] && [ -n "$DEFAULT_IFACE" ]; then
    ufw route allow in on "$DEFAULT_IFACE" to "$DOCKER_SUBNET"
else
    echo "WARNING: Docker subnet or interface not detected, skipping route rule"
fi

# Enable
ufw --force enable

echo ""
echo "UFW status:"
ufw status verbose
