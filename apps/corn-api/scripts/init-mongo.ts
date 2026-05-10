// Standalone mongo bootstrap — connects to MONGODB_URI, runs syncIndexes()
// for every model, seeds singletons, applies pending JS migrations.
// Idempotent.
//
// Usage (host shell — NOT inside the corn-api container):
//   MONGODB_URI=mongodb://cornhub:***@127.0.0.1:27017/cornhub?... \
//     pnpm --filter @corn/corn-api run init-mongo
//
// MONGODB_URI must be in process.env. Pull it from `infra/.env` either via
// `docker compose run --rm --env-file ../../infra/.env corn-api ...` or
// shell-export it manually for ad-hoc runs.
//
// Run this once before the first cutover (Phase 5 step 3) and any time
// you wipe the Mongo DB during dev.

import { connectMongoose, disconnectMongoose } from '../src/db/mongoose/connection.js'
import { initSchemas } from '../src/db/mongoose/init.js'
import { runMigrations } from '../src/db/mongoose/migrations/_runner.js'

async function main(): Promise<void> {
  const uri = process.env['MONGODB_URI']
  if (!uri) {
    console.error('[init-mongo] MONGODB_URI is required')
    process.exit(1)
  }

  console.log('[init-mongo] connecting...')
  await connectMongoose(uri)

  console.log('[init-mongo] syncing indexes + seeding singletons...')
  await initSchemas()

  console.log('[init-mongo] running pending JS migrations...')
  await runMigrations()

  await disconnectMongoose()
  console.log('[init-mongo] done')
}

main().catch((err) => {
  console.error('[init-mongo] failed:', err)
  process.exitCode = 1
})
