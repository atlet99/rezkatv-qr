include .env
export

SOPS_KEY_FILE ?= $(HOME)/.sops/key.txt
LOGROTATE_CONF = /etc/logrotate.d/nginx

.PHONY: help up down restart restart-app logs deploy sops-init sops-enc sops-dec setup-ufw setup-fail2ban setup-logrotate logrotate-check logrotate-run

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

up: ## Start all services
	docker compose up -d --build

down: ## Stop all services
	docker compose down

restart: ## Restart nginx (e.g. after configuration changes)
	docker compose restart nginx

restart-app: ## Rebuild and restart the Node.js API (app)
	docker compose up -d --build app

logs: ## Show nginx logs
	docker logs -f qr-auth-nginx

sops-init: ## Generate new age key for SOPS
	mkdir -p $(HOME)/.sops
	@if [ ! -f $(HOME)/.sops/key.txt ]; then \
		age-keygen -o $(HOME)/.sops/key.txt; \
		echo "Please update .sops.yaml with this public key:"; \
		age-keygen -y $(HOME)/.sops/key.txt; \
	else \
		echo "Key already exists at $(HOME)/.sops/key.txt"; \
	fi

sops-enc: ## Encrypt crt.pem and crt.key
	SOPS_AGE_KEY_FILE=$(SOPS_KEY_FILE) sops --encrypt certs/crt.pem > certs/enc.crt.pem
	SOPS_AGE_KEY_FILE=$(SOPS_KEY_FILE) sops --encrypt certs/crt.key > certs/enc.crt.key
	@echo "Files encrypted successfully"

sops-dec: ## Decrypt certificates
	SOPS_AGE_KEY_FILE=$(SOPS_KEY_FILE) sops --decrypt certs/enc.crt.pem > certs/crt.pem
	SOPS_AGE_KEY_FILE=$(SOPS_KEY_FILE) sops --decrypt certs/enc.crt.key > certs/crt.key
	@chmod 600 certs/crt.key
	@echo "Certificates decrypted for Nginx"

setup-ufw: ## Auto-configure UFW firewall
	bash scripts/setup-ufw.sh

setup-fail2ban: ## Auto-configure fail2ban rules
	bash scripts/setup-fail2ban.sh

setup-logrotate: ## Install nginx/logrotate.conf to /etc/logrotate.d/nginx
	cp nginx/logrotate.conf $(LOGROTATE_CONF)
	@echo "Installed $(LOGROTATE_CONF)"

logrotate-check: ## Dry-run logrotate (no changes, just validation)
	logrotate -d $(LOGROTATE_CONF)

logrotate-run: ## Force logrotate right now (for testing)
	logrotate -f $(LOGROTATE_CONF)

deploy: sops-dec up ## Full deploy: decrypt certs and start services