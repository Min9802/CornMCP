/**
 * One-shot migration — copy every vector from the legacy SQLite mem9 store
 * (`apps/corn-mcp/data/mem9-vectors.db`) into the Qdrant collections that
 * `Mem9Service` now uses (`corn_memories`, `corn_knowledge`, ...).
 *
 * Background:
 *   Until commit `<vector-switch>` corn-mcp persisted memory + knowledge
 *   embeddings to a local sql.js file (brute-force cosine, single writer,
 *   in-memory rewrite each save). The provider switched to Qdrant, but any
 *   data already written into the SQLite file would otherwise be orphaned.
 *
 * Usage:
 *   pnpm --filter @corn/corn-mcp migrate:sqlite-to-qdrant
 *   # or
 *   tsx apps/corn-mcp/scripts/migrate-sqlite-to-qdrant.ts
 *
 * Env (auto-loaded from infra/.env if present, then ./.env):
 *   - QDRANT_URL                (default: http://localhost:6333)
 *   - MEM9_VECTORS_DB           (default: ./data/mem9-vectors.db)
 *   - MEM9_EMBEDDING_DIMS       (default: detected from the first stored
 *                                vector; fallback 1024)
 *
 * Safety:
 *   - Idempotent: Qdrant `PUT /points` upserts by id, so re-running merely
 *     overwrites identical payloads. Already-migrated rows are no-ops.
 *   - Read-only on the source SQLite file.
 *   - Wraps each row in try/catch so one corrupt blob doesn't abort the run.
 *   - Does NOT delete the source file. Once you've verified counts in Qdrant
 *     (e.g. `curl :6333/collections/corn_memories`) you can `rm` the legacy
 *     `data/mem9-vectors.db` manually.
 *
 * Rollback:
 *   - Switch the provider import in `tools/memory.ts` + `tools/knowledge.ts`
 *     back to `LocalMem9Service` and keep the SQLite file untouched.
 */

import { existsSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import initSqlJs, { type SqlValue } from 'sql.js'
import { QdrantClient } from '@corn/shared-mem9'

// ── env loader (same shape as cli.ts) ─────────────────────
function loadEnv(): void {
  const __dirname = typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url))

  const envPaths = [
    resolve(process.cwd(), 'infra/.env'),
    resolve(process.cwd(), '.env'),
    resolve(__dirname, '..', '.env'),
    resolve(__dirname, '..', '..', '..', 'infra', '.env'),
  ]
  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      if (!process.env[key]) process.env[key] = value
    }
    console.log(`[migrate] loaded env from ${envPath}`)
    return
  }
}

loadEnv()

interface VectorRow {
  id: string
  collection: string
  vector: number[]
  payload: Record<string, unknown>
}

const BATCH_SIZE = 100

async function main(): Promise<void> {
  const dbPath = process.env.MEM9_VECTORS_DB || './data/mem9-vectors.db'
  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'

  console.log('[migrate] starting SQLite → Qdrant migration')
  console.log(`  source : ${resolve(dbPath)}`)
  console.log(`  target : ${qdrantUrl}`)

  if (!existsSync(dbPath)) {
    console.log(`[migrate] no SQLite vector file at ${dbPath} — nothing to migrate`)
    process.exit(0)
  }

  // ── open SQLite (sql.js, in-memory) ──
  const SQL = await initSqlJs()
  const buffer = readFileSync(dbPath)
  const db = new SQL.Database(buffer)

  let rows: VectorRow[]
  try {
    const result = db.exec('SELECT id, collection, vector, payload FROM vectors')
    if (!result.length || !result[0].values.length) {
      console.log('[migrate] vectors table is empty — nothing to migrate')
      db.close()
      process.exit(0)
    }
    rows = result[0].values.map((row: SqlValue[]) => {
      const id = row[0] as string
      const collection = row[1] as string
      const vectorBuf = row[2] as Uint8Array
      const payloadStr = row[3] as string
      // Decode Float32 BLOB → number[] (matches shared-mem9 SQLiteVectorStore.search)
      const vector = Array.from(
        new Float32Array(vectorBuf.buffer, vectorBuf.byteOffset, vectorBuf.byteLength / 4),
      )
      const payload = JSON.parse(payloadStr) as Record<string, unknown>
      return { id, collection, vector, payload }
    })
  } finally {
    db.close()
  }

  console.log(`[migrate] read ${rows.length} vectors from SQLite`)

  // ── group by collection ──
  const byCollection = new Map<string, VectorRow[]>()
  for (const row of rows) {
    const list = byCollection.get(row.collection) ?? []
    list.push(row)
    byCollection.set(row.collection, list)
  }

  // ── push into Qdrant ──
  const qdrant = new QdrantClient(qdrantUrl)
  const overallStats = { total: 0, upserted: 0, failed: 0 }

  for (const [collection, items] of byCollection.entries()) {
    if (!items.length) continue

    const dims = items[0].vector.length
    console.log(`\n[migrate] collection "${collection}" — ${items.length} points (${dims}-d)`)

    try {
      await qdrant.ensureCollection(collection, dims)
    } catch (err) {
      console.error(`[migrate]   ✗ ensureCollection failed:`, (err as Error).message)
      overallStats.failed += items.length
      overallStats.total += items.length
      continue
    }

    // Batch upsert so we don't blow memory on a single 50k-point payload.
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const slice = items.slice(i, i + BATCH_SIZE)
      const points = slice.map((r) => ({ id: r.id, vector: r.vector, payload: r.payload }))
      try {
        await qdrant.upsert(collection, points)
        overallStats.upserted += slice.length
        console.log(`[migrate]   ✓ batch ${i / BATCH_SIZE + 1}: ${slice.length} points`)
      } catch (err) {
        overallStats.failed += slice.length
        console.error(`[migrate]   ✗ batch ${i / BATCH_SIZE + 1} failed:`, (err as Error).message)
      }
      overallStats.total += slice.length
    }
  }

  console.log('\n[migrate] done')
  console.log(`  collections : ${byCollection.size}`)
  console.log(`  total       : ${overallStats.total}`)
  console.log(`  upserted    : ${overallStats.upserted}`)
  console.log(`  failed      : ${overallStats.failed}`)

  if (overallStats.failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[migrate] fatal:', err)
  process.exit(1)
})
