-include .env
export

CERTBOT_IMAGE = certbot/certbot:v5.3.1
CERTBOT_VOLUMES = -v ./certbot/www:/var/www/certbot -v ./certbot/conf:/etc/letsencrypt

.PHONY: help up down restart restart-app logs cert-test cert-test-dry cert-prod cert-prod-dry cert-renew cert-cron cert-clean

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

cert-test: ## Obtain staging SSL certificate (no rate limits)
	docker run --rm $(CERTBOT_VOLUMES) $(CERTBOT_IMAGE) \
		certonly --webroot -w /var/www/certbot \
		-d $(DOMAIN) -m $(CERTBOT_EMAIL) \
		--agree-tos -n --test-cert
	docker compose restart nginx

cert-test-dry: ## Dry run staging certificate (verify Let's Encrypt access)
	docker run --rm $(CERTBOT_VOLUMES) $(CERTBOT_IMAGE) \
		certonly --webroot -w /var/www/certbot \
		-d $(DOMAIN) -m $(CERTBOT_EMAIL) \
		--agree-tos -n --test-cert --dry-run

cert-prod: ## Obtain production SSL certificate
	docker run --rm $(CERTBOT_VOLUMES) $(CERTBOT_IMAGE) \
		certonly --webroot -w /var/www/certbot \
		-d $(DOMAIN) -m $(CERTBOT_EMAIL) \
		--agree-tos -n --force-renewal
	docker compose restart nginx

cert-prod-dry: ## Dry run production certificate (verify Let's Encrypt access)
	docker run --rm $(CERTBOT_VOLUMES) $(CERTBOT_IMAGE) \
		certonly --webroot -w /var/www/certbot \
		-d $(DOMAIN) -m $(CERTBOT_EMAIL) \
		--agree-tos -n --dry-run

cert-renew: ## Smart renewal (retry via staging on failure)
	$(CURDIR)/scripts/cert-renew.sh

cert-retry: ## Retry failed renewal (staging check → production)
	$(CURDIR)/scripts/cert-retry.sh

cert-cron: ## Install smart renewal cron (every 15 days + 4h retry)
	@(crontab -l 2>/dev/null | grep -v 'cert-renew\|cert-retry'; \
		echo "0 3 1,15 * * cd $(CURDIR) && ./scripts/cert-renew.sh >> /var/log/cert-renew.log 2>&1"; \
		echo "0 */4 * * * cd $(CURDIR) && ./scripts/cert-retry.sh >> /var/log/cert-renew.log 2>&1") | crontab -
	@echo "Cron jobs installed:"
	@echo "  - Renewal:  every 15 days at 3:00 AM"
	@echo "  - Retry:    every 4 hours (only runs if renewal failed)"
	@echo "  - Logs:     /var/log/cert-renew.log"
	@echo "Verify with: crontab -l"

cert-clean: ## Remove all certificates and certbot data
	rm -rf certbot/conf/* certbot/www/*
	@echo "Certbot data cleaned. Run 'make cert-test' or 'make cert-prod' to obtain new certificates."

deploy: up cert-prod ## Full deploy: start services + production certificate
