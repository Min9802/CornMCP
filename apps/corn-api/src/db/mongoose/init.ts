// Schema initialization: ensure indexes are in sync with each schema's
// definition AND seed bootstrap singletons (setup_status only).
// Idempotent — safe to call on every boot.
//
// Note: the legacy `org-default` shared organization is no longer seeded.
// Every user must own their own org (auto-created on first project create or
// via POST /api/orgs). The previous shared-org pattern caused cross-tenant
// leaks via auto-merged scope in middleware/auth.ts.
//
// Order matters:
//   1. syncIndexes() per model so unique constraints exist BEFORE seed
//      tries to insert.
//   2. Upsert singletons via $setOnInsert so a re-run never overwrites
//      changes made by the admin UI.
//
// Caller (apps/corn-api/src/index.ts) invokes initSchemas() right after
// `initDatabase()` resolves under the mongo branch.

import * as Models from './index.js'
import { createLogger } from '@corn/shared-utils'

const logger = createLogger('mongoose:init')

export async function initSchemas(): Promise<void> {
  // ── 1. syncIndexes ──
  // syncIndexes() is destructive: it drops indexes that no longer exist
  // in the schema and adds new ones. That's the contract we want during
  // active development. In production this should be a separate, gated
  // migration step — revisit at Phase 6.
  let synced = 0
  for (const [name, M] of Object.entries(Models)) {
    // Filter to actual Mongoose Models. We export connection helpers
    // and types from the same barrel; ignore anything that doesn't have
    // syncIndexes.
    const candidate = M as { syncIndexes?: () => Promise<unknown>; modelName?: string }
    if (typeof candidate?.syncIndexes !== 'function') continue
    try {
      await candidate.syncIndexes()
      synced++
    } catch (err) {
      logger.error(`syncIndexes failed for ${name}:`, err)
      throw err
    }
  }
  logger.info(`Synced indexes for ${synced} models`)

  // ── 2. Seed bootstrap singletons ──
  await Models.SetupStatus.findOneAndUpdate(
    { _id: 'singleton' },
    { $setOnInsert: { _id: 'singleton', completed: false, completed_at: null } },
    { upsert: true, setDefaultsOnInsert: true },
  )

  logger.info('Bootstrap singletons seeded (setup_status)')
}
