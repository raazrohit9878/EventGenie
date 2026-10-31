# EventGenie AI

EventGenie is a responsive event-planning app with an Express backend, SQLite persistence, account registration/login, per-account workspaces, and a local demo mode.

## Quick start on Windows

Install Node.js 22 or newer, then double-click `Run-EventGenie.bat`. The launcher installs locked dependencies when needed, creates `.env` from `.env.example`, and starts the app at `http://127.0.0.1:8000`. Keep the terminal window open while using it. The SQLite database is stored at `data/eventgenie.sqlite`.

For a manual setup:

```sh
copy .env.example .env       # Windows; on macOS/Linux use: cp .env.example .env
npm ci
npm start
```

With npm 12's install-script approval enabled, approve the SQLite native driver before installing if npm asks: `npm install-scripts approve better-sqlite3`, then run `npm ci` again.

## Docker deployment

Local HTTP deployment:

```sh
docker compose up --build -d
```

This publishes the application only on `127.0.0.1:8000` and persists SQLite in the `eventgenie_data` volume. For public HTTPS deployment, point a DNS name to the host, copy `.env.example` to `.env`, set `NODE_ENV=production` and `DOMAIN=events.example.com`, then run:

```sh
docker compose --profile https up --build -d
```

The optional Caddy service obtains and renews TLS certificates. Ports 80 and 443 must be reachable from the internet. The app container stays bound to loopback; Caddy proxies to it. `NODE_ENV=production` enables Secure session cookies, so set it when using HTTPS.

## NVIDIA NIM chat setup

AI chat requires an NVIDIA API key. Get a key through NVIDIA's API catalog, then put it in the backend `.env` file; never add it to frontend code. `.env.example` selects `nvidia/nemotron-3.5-lightning-30b-a3b`. This currently listed 30B NVIDIA model was verified against the hosted NIM endpoint. Meta Llama 3.1/3.3 70B hosted endpoints return HTTP 410 (retired); a working 70B option requires an active partner or self-hosted endpoint. See the [Nemotron 3.5 Lightning model page](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b) and the official [NVIDIA NIM LLM API reference](https://docs.api.nvidia.com/nim/reference/llm-apis).

```env
NVIDIA_API_KEY=your_real_nvidia_api_key
NVIDIA_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
```

Restart the backend after editing `.env`. Without these values, EventGenie stays runnable and displays an explicit “AI chat is not configured” error; it does not substitute a mock answer. Run `npm run test:nim` to make a live request and confirm the configured and response model. The command exits with a setup message if credentials are absent. Chat conversations are stored per account in SQLite. Chat context is retrieved from that account's workspace; guest contact details are excluded. Budget and guest-count changes are deterministic server proposals and only apply after the user confirms them in chat.

The assistant can prepare changes to event details, tasks, expenses, vendors, and guest entries using a constrained NVIDIA function call. The backend validates each proposal against the user's workspace, stores it against the current revision, and applies it only after explicit confirmation. In the local demo, the same proposal is validated server-side and applied to browser storage only after confirmation. No LLM output is executed as code or SQL.

To check health, open `/api/health`. The JSON API is same-origin under `/api`.

## Backend capabilities

- Registration and login with bcrypt password hashes (12 rounds), minimum 12-character passwords, generic login errors, and per-IP rate limiting.
- Random 256-bit server sessions stored as SHA-256 digests in SQLite. Session cookies are HttpOnly, SameSite Strict, and Secure in production. Logout revokes the session.
- Per-user workspaces: each account can read and update only its own saved event data. Workspace writes are size limited and validated on the server.
- SQLite WAL mode, foreign keys, graceful process shutdown, persistent Docker volume, and a health check.
- Server-calculated budget summaries at `/api/summary`; browser calculations remain deterministic for the UI.
- Helmet security headers, a restrictive content security policy, JSON body limits, same-origin checks on mutations, and no CORS access for unrelated sites.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `POST` | `/api/auth/register` | Create account and starter workspace |
| `POST` | `/api/auth/login` | Create session |
| `GET` | `/api/auth/me` | Current account |
| `POST` | `/api/auth/logout` | Revoke current session |
| `GET` | `/api/workspace` | Read current user's workspace |
| `PUT` | `/api/workspace` | Validate and save current user's workspace |
| `GET` | `/api/summary` | Deterministic budget and task totals |
| `GET` | `/api/chat/status` | NIM configuration status (never returns the key) |
| `GET` | `/api/chat/history` | Current account's saved chat history |
| `POST` | `/api/chat` | Generate and save a NIM response using saved event context |
| `POST` | `/api/demo/chat` | Rate-limited NIM chat for local demo workspaces; no server-side conversation persistence |
| `DELETE` | `/api/chat/history` | Clear current account's history and pending proposals |
| `POST` | `/api/chat/actions/:actionId` | Confirm or reject a proposed budget/guest change |

The UI uses the backend automatically when it is available. Local demo mode keeps event data and chat history in browser storage and does not provide account security. When the backend and NVIDIA key are configured, demo users can still use the real NVIDIA chat through a rate-limited endpoint; messages are not saved to the server in demo mode. If the backend is unavailable, chat reports that clearly instead of returning a mock response.

## Configuration and operations

Copy `.env.example` to `.env` and configure `PORT`, `HOST`, `DB_PATH`, and `SESSION_DAYS` as needed. Keep `.env` and the database out of source control. Back up the SQLite database regularly; for a live backup, use SQLite's backup API rather than copying only the main database file while the app is running. Protect backup files because they contain event and guest data.

Use `npm test` for backend, context, action validation, and NIM adapter tests; `npm run check` for syntax checks; `npm run test:nim` for a live NVIDIA request; `npm run test:nim:actions` to verify live function calling; and `npm run test:chat-live` to audit questions, actions, bilingual inputs, birthday follow-ups, authorization, and local-demo isolation against an isolated temporary database. Live checks require NVIDIA credentials; the chat audit never touches a production workspace.

## Current scope and production limits

The app supports one active event workspace per account. The NVIDIA assistant is a real NIM-backed chatbot when configured; theme gallery cards remain curated examples. Vendor records are user-entered and are not verified. Email/SMS delivery, password reset, account deletion, MFA, PDF export, and streamed token responses are not implemented. The service is designed for one Node instance using SQLite; choose a managed relational database and shared session/rate-limit stores before horizontal scaling.
