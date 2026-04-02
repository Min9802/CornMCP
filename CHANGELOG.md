# Changelog

All notable changes to Corn Hub will be documented in this file.

## [0.3.2] - 2026-04-02

### Added
- **Google OAuth login**: "Continue with Google" button on login page
  - `GET /api/auth/google` → redirects to Google consent screen
  - `GET /api/auth/google/callback` → exchanges code, creates/links user, sets JWT cookie
  - New users via Google always get `user` role (unless first user ever → `admin`)
  - Existing users can link Google to their account by logging in with Google using the same email
  - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars (no extra packages needed — uses native `fetch`)
- **DB schema**: `users.google_id` (unique), `users.avatar_url`, `password_hash` now nullable (Google-only users have no password)
- **Login page**: Google button + "or" divider above the email/password form; OAuth error messages mapped to human-readable strings

## [0.3.1] - 2026-04-02

### Fixed
- **Docker build error**: `.dockerignore` changed from `node_modules` to `**/node_modules` to exclude all nested node_modules (was causing `cannot copy to non-directory` error on Ubuntu)
- **Port conflict**: `corn-api` host port changed from `4000` to `6100` to avoid conflict with other services

### Added
- **Configurable ports via `.env`**: Added `API_PORT`, `MCP_PORT`, `WEB_PORT` variables — host ports now driven from `.env` with fallback defaults
- **`NEXT_PUBLIC_MCP_URL`**: New env var for MCP server public URL, passed as Docker build arg to `corn-web`
- **`Dockerfile.corn-web`**: Added `ARG/ENV NEXT_PUBLIC_MCP_URL` in builder stage

### Changed
- **Setup & Settings pages**: `useServiceUrls()` now reads from `process.env.NEXT_PUBLIC_API_URL` and `process.env.NEXT_PUBLIC_MCP_URL` instead of constructing URLs from `window.location.hostname + hardcoded ports`
- **Nginx `/mcp/` routing**: Must use trailing slash on both `location /mcp/` and `proxy_pass http://127.0.0.1:8317/` to correctly strip the `/mcp` prefix when forwarding to MCP container

## [0.3.0] - 2026-04-02

### Added
- **Authentication system**: Login/Register with JWT cookies, bcrypt password hashing
- **User management**: Admin/User roles, user CRUD (admin only)
- **Open registration**: Anyone can register with `user` role, first user auto-becomes `admin`
- **Multi-user data isolation**: API keys, providers, organizations, knowledge, quality reports scoped per user
- **MCP API key auth from DB**: API keys validated against database via `POST /api/auth/validate-key`
- **anyAuthMiddleware**: Accepts both JWT cookie and API key, loads full user context for both
- **OAuth discovery endpoints**: VS Code Copilot compatibility (`/.well-known/oauth-authorization-server`)
- **Auto-create project/org**: `corn_session_start` creates project and organization if not exists
- **Organization CRUD**: Create, edit, delete organizations in dashboard
- **Provider edit**: Edit functionality for providers page
- **Favicon**: SVG favicon with 🌽 emoji, removed old `.ico`
- **Setup page**: Updated repo URL to `Min9802/CornMCP`, added all env variables

### Fixed
- **corn_tool_stats 401**: Analytics route now uses `anyAuthMiddleware` instead of `jwtAuthMiddleware`
- **MCP analytics tool**: Added `X-API-Key` header forwarding in fetch calls
- **CORS**: Changed from wildcard `*` to specific origin via `CORS_ORIGIN` env with `credentials: true`
- **0.0.0.0 binding**: Both `corn-api` and `corn-mcp` bind to `0.0.0.0` for Docker compatibility
- **URL configuration**: All URLs configurable via `.env`, no hardcoded `localhost` or IPs
- **Dynamic URLs**: Settings/Setup pages use `window.location.hostname` instead of hardcoded values

### Changed
- MCP auth migrated from env-based `MCP_API_KEYS` to DB validation per-user
- Dashboard layout: client-side auth redirect (replaced deprecated `middleware.ts`)
- All 18 MCP tools verified working

## [0.2.1] - Previous

- Docker build fixes, git in builder, shared pkg exports, API URL config
