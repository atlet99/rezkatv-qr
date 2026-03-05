include .env
export

.PHONY: help up down restart restart-app logs deploy

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

deploy: up ## Full deploy: start services
