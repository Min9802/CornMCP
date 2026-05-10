/**
 * Phase S1.4 — Encrypt existing plain-text `provider_accounts.api_key` rows.
 *
 * Run once after deploying S1 code to encrypt legacy keys. Idempotent: rows
 * already in `enc:v1:` envelope (or with NULL/empty key) are skipped.
 *
 * Usage:
 *   pnpm --filter @corn/corn-api migrate:encrypt-keys
 *   # or
 *   tsx apps/corn-api/scripts/migrate-encrypt-keys.ts
 *
 * Env vars required:
 *   - DATABASE_PATH (defaults to ./data/corn.db)
 *   - SYSTEM_SETTINGS_MASTER_KEY (or AUTH_JWT_SECRET fallback)
 *
 * Safety:
 *   - Read-only on rows already encrypted (`api_key_encrypted = 1`).
 *   - Wrapped per-row in try/catch — one bad row doesn't abort the sweep.
 *   - Calls `flushDb()` at the end so the sql.js debounced writer is drained
 *     before the process exits (otherwise updates would be lost on quick exit).
 *
 * Rollback:
 *   - Use `decrypt-keys.ts` (mirror script with `decrypt()` instead). Or:
 *     1. SELECT id, api_key FROM provider_accounts WHERE api_key_encrypted = 1
 *     2. For each: UPDATE provider_accounts SET api_key = decrypt(api_key),
 *        api_key_encrypted = 0 WHERE id = ?
 */

import { dbAll, dbRun, flushDb, closeDb } from '../src/db/client.js'
import { encrypt, isEncrypted } from '../src/services/secrets.js'

interface ProviderRow {
  id: string
  api_key: string | null
  api_key_encrypted: number
}

async function main(): Promise<void> {
  console.log('[migrate-encrypt-keys] starting sweep...')

  const rows = (await dbAll(
    'SELECT id, api_key, api_key_encrypted FROM provider_accounts',
  )) as unknown as ProviderRow[]

  let scanned = 0
  let encrypted = 0
  let skippedEmpty = 0
  let skippedAlready = 0
  let failed = 0

  for (const row of rows) {
    scanned++
    const apiKey = row.api_key

    if (apiKey === null || apiKey === '') {
      skippedEmpty++
      continue
    }
    if (isEncrypted(apiKey)) {
      // Make sure the flag matches reality even if the column was added late.
      if (row.api_key_encrypted !== 1) {
        await dbRun(
          'UPDATE provider_accounts SET api_key_encrypted = 1 WHERE id = ?',
          [row.id],
        )
      }
      skippedAlready++
      continue
    }

    try {
      const wrapped = encrypt(apiKey) as string
      await dbRun(
        'UPDATE provider_accounts SET api_key = ?, api_key_encrypted = 1, updated_at = datetime(\'now\') WHERE id = ?',
        [wrapped, row.id],
      )
      encrypted++
      console.log(`[migrate-encrypt-keys]   ✓ encrypted ${row.id}`)
    } catch (err) {
      failed++
      console.error(`[migrate-encrypt-keys]   ✗ failed ${row.id}:`, (err as Error).message)
    }
  }

  // Drain the sql.js debounced writer before exit so updates persist.
  await flushDb()
  closeDb()

  console.log('[migrate-encrypt-keys] done')
  console.log(`  scanned        : ${scanned}`)
  console.log(`  encrypted      : ${encrypted}`)
  console.log(`  skipped (empty): ${skippedEmpty}`)
  console.log(`  skipped (done) : ${skippedAlready}`)
  console.log(`  failed         : ${failed}`)

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[migrate-encrypt-keys] fatal:', err)
  process.exit(1)
})
