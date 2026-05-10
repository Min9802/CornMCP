import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { createLogger } from '@corn/shared-utils'
import { getDb, closeDb, flushDb } from './db/client.js'
import { keysRouter } from './routes/keys.js'
import { sessionsRouter } from './routes/sessions.js'
import { qualityRouter } from './routes/quality.js'
import { knowledgeRouter } from './routes/knowledge.js'
import { memoryRouter } from './routes/memory.js'
import { projectsRouter, orgsRouter } from './routes/projects.js'
import { metricsRouter } from './routes/stats.js'
import { providersRouter } from './routes/providers.js'
import { usageRouter } from './routes/usage.js'
import { analyticsRouter } from './routes/analytics.js'
import { setupRouter } from './routes/setup.js'
import { webhooksRouter } from './routes/webhooks.js'
import { intelRouter } from './routes/intel.js'
import { systemRouter } from './routes/system.js'
import { indexingRouter } from './routes/indexing.js'
import { authRouter } from './routes/auth.js'
import { usersRouter } from './routes/users.js'
import { llmRouter, llmAdminRouter } from './routes/llm.js'
import { startSessionLifecycleJob } from './services/session-lifecycle.js'
import { seedDefaultTaskEngines } from './services/task-engines.js'

const app = new Hono()
const logger = createLogger('corn-api')

const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000'
app.use('*', cors({
  origin: corsOrigin,
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}))
app.use('*', honoLogger())

// ─── Health ─────────────────────────────────────────────
app.get('/health', async (c) => {
  async function checkService(name: string, url: string): Promise<'ok' | 'error'> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      return res.ok ? 'ok' : 'error'
    } catch {
      return 'error'
    }
  }

  // Check sqlite (our actual vector store — replaced Qdrant)
  let sqlite: 'ok' | 'error' = 'ok'
  try {
    const { dbGet } = await import('./db/client.js')
    const row = await dbGet('SELECT COUNT(*) as cnt FROM code_symbols')
    sqlite = row ? 'ok' : 'error'
  } catch {
    sqlite = 'error'
  }

  const mcpUrl = process.env['MCP_URL'] || 'http://localhost:8317'
  const mcp = await checkService('mcp', `${mcpUrl}/health`)

  const allOk = sqlite === 'ok' && mcp === 'ok'

  return c.json({
    status: allOk ? 'ok' : (sqlite === 'ok' ? 'degraded' : 'error'),
    service: 'corn-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    services: { sqlite, api: 'ok' as const, mcp },
  })
})

// ─── Routes ─────────────────────────────────────────────
app.route('/api/auth', authRouter)
app.route('/api/users', usersRouter)
app.route('/api/keys', keysRouter)
app.route('/api/sessions', sessionsRouter)
app.route('/api/quality', qualityRouter)
app.route('/api/knowledge', knowledgeRouter)
app.route('/api/memories', memoryRouter)
app.route('/api/projects', projectsRouter)
app.route('/api/orgs', orgsRouter)
app.route('/api/metrics', metricsRouter)
app.route('/api/analytics', analyticsRouter)
app.route('/api/providers', providersRouter)
app.route('/api/usage', usageRouter)
app.route('/api/setup', setupRouter)
app.route('/api/webhooks', webhooksRouter)
app.route('/api/intel', intelRouter)
app.route('/api/system', systemRouter)
app.route('/api/indexing', indexingRouter)
app.route('/api/llm', llmRouter)
app.route('/api/llm', llmAdminRouter)

// ─── Root ───────────────────────────────────────────────
app.get('/', (c) => {
  return c.json({
    name: 'Corn Dashboard API',
    version: '0.1.0',
    endpoints: [
      '/health',
      '/api/keys',
      '/api/sessions',
      '/api/quality',
      '/api/knowledge',
      '/api/memories',
      '/api/projects',
      '/api/orgs',
      '/api/metrics',
      '/api/providers',
      '/api/usage',
      '/api/setup',
    ],
  })
})

// ─── Start ──────────────────────────────────────────────
const port = Number(process.env['PORT']) || 4000

async function start() {
  // Initialize database before serving
  await getDb()
  logger.info('Database ready')

  // ── Task engine seed (S5.1) ────────────────────────────
  // Idempotent — only inserts rows that don't exist. Schema migration
  // 0015 already seeded a fresh DB; this catches the path where the
  // schema mirror in `schema.sql` ran (DDL only, no data) ahead of the
  // migration on a brand-new file.
  try {
    const { inserted } = await seedDefaultTaskEngines()
    if (inserted.length) logger.info(`Task engines seeded: ${inserted.join(', ')}`)
  } catch (err) {
    logger.error('Failed to seed task engines:', err)
  }

  // ── Session auto-close sweep ────────────────────────────
  // Sessions stuck in 'active' (e.g. agent crashed before corn_session_end)
  // are flipped to 'abandoned' after `SESSION_AUTO_CLOSE_MINUTES` of no
  // activity. PATCH and POST /:id/heartbeat both refresh activity.
  const timeoutMinutes = Math.max(
    1,
    Number(process.env['SESSION_AUTO_CLOSE_MINUTES']) || 60,
  )
  const checkIntervalMs = Math.max(
    30_000,
    Number(process.env['SESSION_CHECK_INTERVAL_MS']) || 5 * 60_000,
  )
  startSessionLifecycleJob({ timeoutMinutes, checkIntervalMs })
  logger.info(
    `Session auto-close enabled (timeout=${timeoutMinutes}m, check=${Math.round(checkIntervalMs / 1000)}s)`,
  )

  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
    logger.info(`🌽 Corn Dashboard API listening on http://0.0.0.0:${port}`)
  })

  // ── Graceful shutdown ───────────────────────────────────
  // The DB persist layer is debounced (see db/client.ts) so an unflushed
  // write window exists between dbRun and disk commit. SIGTERM (sent by
  // docker stop / compose down) and SIGINT must drain that window before we
  // exit — otherwise the most recent writes are lost.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`Received ${signal}, flushing DB and shutting down...`)
    try {
      await flushDb()
    } catch (err) {
      logger.error('Error flushing DB during shutdown:', err)
    }
    try {
      closeDb()
    } catch (err) {
      logger.error('Error closing DB during shutdown:', err)
    }
    server.close(() => process.exit(0))
    // Hard-fail safety: don't hang forever if HTTP sockets won't close.
    setTimeout(() => process.exit(0), 5_000).unref()
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

start().catch((err) => {
  logger.error('Failed to start:', err)
  process.exit(1)
})
