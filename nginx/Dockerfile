FROM nginx:1.25-alpine

RUN apk add --no-cache openssl inotify-tools

COPY init-cert.sh /docker-entrypoint.d/
COPY watch-certs.sh /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/*.sh