# Changelog

All notable changes to Corn Hub will be documented in this file.

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
