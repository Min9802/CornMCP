import { Hono } from 'hono'
import { dbAll, dbGet, dbRun } from '../db/client.js'

export const setupRouter = new Hono()

// ─── Get setup status ───────────────────────────────────
setupRouter.get('/', async (c) => {
  const status = await dbGet('SELECT * FROM setup_status WHERE id = 1')
  return c.json({ completed: !!(status?.completed), completedAt: status?.completed_at })
})

// ─── Complete setup ─────────────────────────────────────
setupRouter.post('/complete', async (c) => {
  await dbRun(
    `UPDATE setup_status SET completed = 1, completed_at = datetime('now') WHERE id = 1`,
  )
  return c.json({ ok: true })
})

// ─── System info ────────────────────────────────────────
setupRouter.get('/system', async (c) => {
  const projects = await dbGet('SELECT COUNT(*) as count FROM projects')
  const keys = await dbGet('SELECT COUNT(*) as count FROM api_keys')
  const providers = await dbGet('SELECT COUNT(*) as count FROM provider_accounts')

  return c.json({
    version: '0.1.0',
    uptime: Math.floor(process.uptime()),
    projects: projects?.count || 0,
    apiKeys: keys?.count || 0,
    providers: providers?.count || 0,
    database: 'sqlite (sql.js)',
    nodeVersion: process.version,
  })
})
