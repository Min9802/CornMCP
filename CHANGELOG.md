# Changelog

All notable changes to Corn Hub will be documented in this file.

## [0.1.0] — 2026-03-28

### 🐛 Bug Fixes

- **SQL injection** in `usage.ts` and `analytics.ts` — user-supplied `days` param was string-interpolated into SQL; now uses parameterized queries (`3852d78`)
- **Route conflict** — both `metricsRouter` and `analyticsRouter` were mounted on `/api/metrics`; analytics moved to `/api/analytics` (`3852d78`)
- **ESM `require()` calls** — replaced CommonJS `require('child_process')` in `system.ts` and `require('node:crypto')` in `shared-utils` with proper ESM imports (`3852d78`)
- **TypeScript parameter properties** — refactored `CornError` and other classes to avoid Node.js strip-only TS mode errors (`1b271e1`, `12c2ee5`)

### 📝 Documentation

- Added MCP path setup guide and troubleshooting section (`30dac4c`)
- Added deep mathematical token economy analysis (`d0b501f`)

### 🎉 Initial Release

- **corn-api** — Hono-based REST API with SQLite (sql.js), serving dashboard data, sessions, quality reports, knowledge, projects, providers, usage, analytics, webhooks, code intel, and system metrics
- **corn-mcp** — MCP server with 17 tools: memory, knowledge, quality, sessions, code intelligence, analytics, and change awareness — supports both Streamable HTTP and STDIO transports
- **corn-web** — Next.js 16 dashboard with real-time health monitoring, activity feed, quality gauges, and quick-connect setup
- **shared-mem9** — Qdrant vector DB client with OpenAI embedding provider for semantic memory and knowledge search
- **shared-types** — Shared TypeScript interfaces for all services
- **shared-utils** — Logger, error classes, ID generation, and utility functions
- Docker Compose infrastructure with Qdrant, nginx, and multi-stage builds (`0bff0fc`)
