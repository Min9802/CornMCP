// Migration runner — Mongo equivalent of the legacy SQLite migrations
// loop in `db/client.ts`. Each migration is a TS module that exports an
// `up()` function; the runner records applied IDs in the `_migrations`
// collection so re-runs are no-ops.
//
// Why a registry array (rather than fs.readdir like the SQLite path)?
//   - Runs identically inside the bundled Docker image where the source
//     directory layout doesn't exist.
//   - Type-safe: each entry is a typed import, errors at compile time
//     if a migration is removed but still listed.
//
// Add new migrations by appending to `migrations[]`. NEVER reorder or
// rename — IDs are recorded permanently.

import mongoose from 'mongoose'
import { createLogger } from '@corn/shared-utils'

const logger = createLogger('mongoose:migrations')

interface MigrationModule {
  up: () => Promise<void>
}

interface MigrationEntry {
  id: string
  load: () => Promise<MigrationModule>
}

// Empty for now — Phase 4 will populate this if any post-migration
// transforms are needed (e.g. backfill columns added after cutover).
// Keep the runner alive even with zero migrations so the wiring is
// proven before we need it.
const migrations: MigrationEntry[] = []

interface AppliedMigration {
  _id: string
  applied_at: Date
}

export async function runMigrations(): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Cannot run migrations — Mongoose not connected')
  }
  const db = mongoose.connection.db
  if (!db) {
    throw new Error('Cannot run migrations — mongoose.connection.db is undefined')
  }

  const coll = db.collection<AppliedMigration>('_migrations')

  for (const m of migrations) {
    const existing = await coll.findOne({ _id: m.id })
    if (existing) {
      continue
    }
    logger.info(`Applying migration ${m.id}...`)
    const mod = await m.load()
    await mod.up()
    await coll.insertOne({ _id: m.id, applied_at: new Date() })
    logger.info(`Migration ${m.id} applied`)
  }
}

export function listRegisteredMigrations(): string[] {
  return migrations.map((m) => m.id)
}
