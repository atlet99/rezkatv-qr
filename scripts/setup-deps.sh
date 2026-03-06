#!/bin/bash
set -e

echo "Installing required dependencies..."
apt update && apt install -y htop curl wget git dnsutils docker.io docker-compose-v2 tree ufw make fail2ban \
    && apt clean all && curl -LO https://github.com/getsops/sops/releases/download/v3.12.1/sops-v3.12.1.linux.amd64 && mv sops-v3.12.1.linux.amd64 /usr/local/bin/sops && chmod +x /usr/local/bin/sops

echo ""
echo "Dependencies installed successfully!"
