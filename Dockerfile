FROM oven/bun:1.3.10

WORKDIR /app

COPY package.json .
RUN bun install --production

COPY index.js .
COPY public/ ./public/

EXPOSE 3000

CMD ["bun", "run", "index.js"]