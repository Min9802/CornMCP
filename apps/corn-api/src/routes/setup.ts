import { Hono } from 'hono'
import {
  SetupStatus,
  Project,
  ApiKey,
  ProviderAccount,
} from '../db/mongoose/index.js'
import { getActiveDriver } from '../db/client.js'

export const setupRouter = new Hono()

// ─── Get setup status ─────────────────────────────────────
setupRouter.get('/', async (c) => {
  // Singleton document with _id='singleton' (seeded by initSchemas).
  const status = await SetupStatus.findById('singleton').lean()
  return c.json({
    completed: !!status?.completed,
    completedAt: status?.completed_at ?? null,
  })
})

// ─── Complete setup ─────────────────────────────────────────
setupRouter.post('/complete', async (c) => {
  await SetupStatus.findOneAndUpdate(
    { _id: 'singleton' },
    { $set: { completed: true, completed_at: new Date() } },
    { upsert: true, setDefaultsOnInsert: true },
  )
  return c.json({ ok: true })
})

// ─── System info ────────────────────────────────────────────
setupRouter.get('/system', async (c) => {
  const [projects, apiKeys, providers] = await Promise.all([
    Project.countDocuments(),
    ApiKey.countDocuments(),
    ProviderAccount.countDocuments(),
  ])

  const driver = getActiveDriver()
  const databaseLabel = driver === 'mongo' ? 'mongodb (mongoose)' : 'sqlite (sql.js)'

  return c.json({
    version: '0.1.0',
    uptime: Math.floor(process.uptime()),
    projects,
    apiKeys,
    providers,
    database: databaseLabel,
    driver: driver ?? 'uninitialized',
    nodeVersion: process.version,
  })
})
