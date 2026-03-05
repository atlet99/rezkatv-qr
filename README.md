# RezkaTV QR Auth Server

A lightweight server for authenticating HDRezka accounts on Smart TV via QR code scanning.

## Preview

![QR Code Example](public/rezka-tv-qr.jpg)

## How It Works

```
┌─────────────┐     1. Create session        ┌─────────────┐
│             │ ───────────────────────────► │             │
│   Smart TV  │   POST { host: "hdrezka.ag" }│   Server    │
│             │ ◄─────────────────────────── │             │
└─────────────┘     2. Return token          └─────────────┘
                                                        │
      ┌─────────────────────────────────────────────────┘
      │ 3. Display QR code with token
      ▼
┌─────────────┐     4. Open auth page       ┌─────────────┐
│             │ ─────────────────────────►  │             │
│  Smartphone │     5. Submit credentials   │   Server    │
│             │ ◄─────────────────────────  │             │
└─────────────┘     6. Login to HDRezka     └─────────────┘
                                                        │
      ┌─────────────────────────────────────────────────┘
      │ 7. Return cookies to TV
      ▼
┌─────────────┐
│   Smart TV  │ ◄── 8. Poll status & get cookies
└─────────────┘
```

## Features

- QR code authentication for HDRezka on Smart TV
- Dynamic host selection (supports different HDRezka mirrors)
- Session-based flow with 5-minute TTL
- Automatic cleanup of expired sessions
- Mobile-friendly auth page
- Docker support with Bun runtime
- Nginx reverse proxy with HTTPS (Let's Encrypt)

## Quick Start

### Using Bun (local development)

```bash
bun install
bun run start
```

### Using Node.js

```bash
npm install
npm start
```

### Using Docker (production)

#### Step 1: Create .env file

```bash
cp .env-example .env
vim .env  # Set DOMAIN and CERTBOT_EMAIL
```

#### Step 2: Start services & obtain SSL

```bash
# Start services (nginx auto-detects SSL certificate)
make up

# Get staging certificate first (no rate limits)
make cert-test

# When ready, get production certificate
make cert-prod
```

Server will be available at `https://your-domain.com`

#### Available Make Commands

| Command          | Description                                |
| ---------------- | ------------------------------------------ |
| `make help`      | Show all available commands                |
| `make up`        | Start all services                         |
| `make down`      | Stop all services                          |
| `make restart`   | Restart nginx (after cert changes)         |
| `make logs`      | Show nginx logs                            |
| `make cert-test` | Obtain staging SSL certificate             |
| `make cert-prod` | Obtain production SSL certificate          |
| `make cert-renew`| Renew existing certificates                |
| `make cert-cron` | Install daily renewal cron job (3:00 AM)   |
| `make deploy`    | Full deploy: start + production cert       |

### Certificate Renewal

Certificates are valid for 90 days. Renew manually or set up auto-renewal:

```bash
# Manual renewal
make cert-renew

# Install auto-renewal cron job
make cert-cron
```

## API Endpoints

| Method | Endpoint                   | Description                                  |
| ------ | -------------------------- | -------------------------------------------- |
| `POST` | `/session/create`          | Create new auth session, returns `{ token }` |
| `GET`  | `/session/check?t=<token>` | Check session status                         |
| `POST` | `/session/submit`          | Submit credentials from smartphone           |
| `GET`  | `/auth?t=<token>`          | Auth page for smartphone (QR target)         |

### POST /session/create

```json
// Request (optional body)
{ "host": "hdrezka.ag" }

// Response
{ "token": "a1b2c3d4e5f6..." }
```

### POST /session/submit

```json
// Request
{ "token": "a1b2c3d4...", "login": "user@example.com", "password": "secret" }

// Response
{ "success": true }
```

### Session Status Response

```json
{ "status": "pending" }
{ "status": "done", "cookies": "dle_user_id=...; dle_password=..." }
{ "status": "error", "error": "Invalid credentials" }
{ "status": "expired" }
```

## Environment Variables

| Variable       | Default      | Description                          |
| -------------- | ------------ | ------------------------------------ |
| `PORT`         | `3000`       | Server port (internal)               |
| `HDREZKA_HOST` | `hdrezka.ag` | Default HDRezka host for login       |
| `DOMAIN`       | —            | Your domain for SSL certificate      |
| `CERTBOT_EMAIL`| —            | Email for Let's Encrypt registration |

## Project Structure

```
rezkatv-qr/
├── index.js                 # Express server with session management
├── public/
│   ├── auth.html            # Mobile auth page
│   └── rezka-tv-qr.jpg      # QR code preview image
├── nginx/
│   ├── docker-entrypoint.sh # Auto-detect SSL entrypoint
│   ├── ssl.conf.template    # Nginx config with HTTPS
│   └── nossl.conf.template  # Nginx config HTTP-only
├── certbot/
│   ├── www/                 # ACME challenge files (auto-created)
│   └── conf/                # Let's Encrypt certificates (auto-created)
├── Makefile                 # Deploy automation commands
├── Dockerfile               # Docker image with Bun
├── docker-compose.yml       # Docker Compose (app + nginx)
├── .env-example             # Environment variables template
├── package.json             # Project metadata
└── README.md                # This file
```

## Docker Services

| Service  | Description                              |
| -------- | ---------------------------------------- |
| `app`    | Bun server on port 3000 (internal)       |
| `nginx`  | Reverse proxy on ports 80, 443 with SSL  |

## Integration with Smart TV App

### Step 1: Create Session

```javascript
const res = await fetch("https://your-domain.com/session/create", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ host: "hdrezka.ag" }),
});
const { token } = await res.json();
```

### Step 2: Generate QR Code

```javascript
const authUrl = `https://your-domain.com/auth?t=${token}`;
// Display this URL as QR code on TV
```

### Step 3: Poll for Status

```javascript
const pollInterval = setInterval(async () => {
  const res = await fetch(`https://your-domain.com/session/check?t=${token}`);
  const data = await res.json();

  if (data.status === "done") {
    clearInterval(pollInterval);
    // Use data.cookies for HDRezka API calls
  } else if (data.status === "error" || data.status === "expired") {
    clearInterval(pollInterval);
    // Handle error or refresh QR
  }
}, 2000);
```

## Security Notes

- Sessions expire after 5 minutes (TTL: 300000ms)
- Tokens are single-use (deleted after successful auth)
- Automatic cleanup removes expired sessions every 60 seconds
- Credentials are transmitted over HTTPS to HDRezka
- Production setup uses HTTPS via Let's Encrypt

## License

MIT License - see [LICENSE](LICENSE) file.