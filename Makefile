include .env
export

SOPS_KEY_FILE ?= $(HOME)/.sops/key.txt

.PHONY: help up down restart restart-app logs deploy sops-init sops-enc sops-dec

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

up: ## Start all services
	docker compose up -d --build

down: ## Stop all services
	docker compose down

restart: ## Restart nginx (e.g. after obtaining certificate)
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

sops-enc: ## Encrypt origin.pem and origin.key
	SOPS_AGE_KEY_FILE=$(SOPS_KEY_FILE) sops --encrypt certs/crt.pem > certs/enc.crt.pem
	SOPS_AGE_KEY_FILE=$(SOPS_KEY_FILE) sops --encrypt certs/crt.key > certs/enc.crt.key
	@echo "Files encrypted successfully"

sops-dec: ## Decrypt certificates
	SOPS_AGE_KEY_FILE=$(SOPS_KEY_FILE) sops --decrypt certs/enc.crt.pem > certs/crt.pem
	SOPS_AGE_KEY_FILE=$(SOPS_KEY_FILE) sops --decrypt certs/enc.crt.key > certs/crt.key
	@chmod 600 certs/crt.key
	@echo "Certificates decrypted for Nginx"

deploy: sops-dec up ## Full deploy: decrypt certs and start services
