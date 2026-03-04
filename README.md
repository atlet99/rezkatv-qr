# RezkaTV QR Auth Server

A lightweight server for authenticating HDRezka accounts on Smart TV via QR code scanning.

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
│             │ ─────────────────────────► │             │
│  Smartphone │     5. Submit credentials  │   Server    │
│             │ ◄───────────────────────── │             │
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

## Quick Start

### Using Bun (recommended)

```bash
bun install
bun run start
```

### Using Docker

```bash
docker-compose up -d
# Server will be available on port 80 (http://your-server/auth?t=...)
```

### Using Node.js

```bash
npm install
npm start
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

| Variable       | Default      | Description                    |
| -------------- | ------------ | ------------------------------ |
| `PORT`         | `3000`       | Server port                    |
| `HDREZKA_HOST` | `hdrezka.ag` | Default HDRezka host for login |

## Project Structure

```
rezkatv-qr/
├── index.js           # Express server with session management
├── public/
│   └── auth.html      # Mobile auth page
├── Dockerfile         # Docker image with Bun
├── docker-compose.yml # Docker Compose config
├── package.json       # Project metadata
└── README.md          # This file
```

## Integration with Smart TV App

### Step 1: Create Session

```javascript
// Local: http://localhost:3000/session/create
// Docker: http://your-server/session/create (port 80)
const res = await fetch("http://your-server:3000/session/create", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ host: "hdrezka.ag" }),
});
const { token } = await res.json();
```

### Step 2: Generate QR Code

```javascript
// Local: http://localhost:3000/auth?t=...
// Docker: http://your-server/auth?t=... (port 80)
const authUrl = `http://your-server:3000/auth?t=${token}`;
// Display this URL as QR code on TV
```

### Step 3: Poll for Status

```javascript
// Poll every 2-3 seconds
// Local: http://localhost:3000/session/check?t=...
// Docker: http://your-server/session/check?t=... (port 80)
const pollInterval = setInterval(async () => {
  const res = await fetch(`http://your-server:3000/session/check?t=${token}`);
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
- Use HTTPS in production for client-server communication

## License

MIT License - see [LICENSE](LICENSE) file.
