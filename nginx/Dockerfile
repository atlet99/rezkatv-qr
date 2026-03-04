FROM nginx:1.25-alpine

RUN apk add --no-cache openssl

COPY init-cert.sh /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/init-cert.sh