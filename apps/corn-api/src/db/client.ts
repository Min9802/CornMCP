import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@corn/shared-utils'

const logger = createLogger('db')

let db: Database | null = null
let dbPath: string = ''

export async function getDb(): Promise<Database> {
  if (db) return db

  dbPath = process.env['DATABASE_PATH'] || './data/corn.db'

  // Ensure data directory exists
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const SQL = await initSqlJs()

  // Load existing DB or create new
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath)
    db = new SQL.Database(buffer)
  } else {
    db = new SQL.Database()
  }

  const __dir = dirname(fileURLToPath(import.meta.url))

  try {
    // 1. Run base schema (CREATE TABLE IF NOT EXISTS — always idempotent)
    const schema = readFileSync(join(__dir, 'schema.sql'), 'utf-8')
    db.run(schema)

    // 2. Ensure migrations tracking table exists
    db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )`)

    // 3. Load applied migrations
    const applied = new Set<string>(
      (db.exec('SELECT name FROM schema_migrations')[0]?.values ?? [])
        .map((r) => r[0] as string),
    )

    // 4. Load & run pending migration files in order
    const migrationsDir = join(__dir, 'migrations')
    if (existsSync(migrationsDir)) {
      const files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort() // lexicographic order → 0001, 0002, ...

      for (const file of files) {
        if (applied.has(file)) continue
        const sql = readFileSync(join(migrationsDir, file), 'utf-8')
        try {
          // Split by ';' to handle multi-statement migrations
          const statements = sql.split(';').map((s) => s.trim()).filter(Boolean)
          for (const stmt of statements) {
            db.run(stmt)
          }
          db.run('INSERT INTO schema_migrations (name) VALUES (?)', [file])
          logger.info(`Migration applied: ${file}`)
        } catch (err) {
          // Some migrations are idempotent (e.g. ADD COLUMN on existing DB)
          // Only skip "already exists" type errors
          const msg = (err as Error).message || ''
          if (
            msg.includes('duplicate column') ||
            msg.includes('already exists') ||
            msg.includes('no such table')
          ) {
            // Mark as applied so we don't retry
            try { db.run('INSERT INTO schema_migrations (name) VALUES (?)', [file]) } catch { /* already marked */ }
            logger.info(`Migration skipped (already applied): ${file}`)
          } else {
            logger.error(`Migration failed: ${file} — ${msg}`)
          }
        }
      }
    }

    saveDb()
    logger.info(`Database initialized at ${dbPath}`)
  } catch (err) {
    logger.error('Failed to initialize database:', err)
    throw err
  }

  return db
}

export function saveDb(): void {
  if (db && dbPath) {
    const data = db.export()
    const buffer = Buffer.from(data)
    writeFileSync(dbPath, buffer)
  }
}

export function closeDb(): void {
  if (db) {
    saveDb()
    db.close()
    db = null
  }
}

// Helper to run a query and return all rows as objects
export async function dbAll(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const database = await getDb()
  const stmt = database.prepare(sql)
  if (params.length > 0) stmt.bind(params as SqlValue[])

  const results: Record<string, unknown>[] = []
  while (stmt.step()) {
    results.push(stmt.getAsObject())
  }
  stmt.free()
  return results
}

// Helper to run a query and return the first row
export async function dbGet(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | undefined> {
  const rows = await dbAll(sql, params)
  return rows[0]
}

// Helper to run an INSERT/UPDATE/DELETE
export async function dbRun(sql: string, params: unknown[] = []): Promise<void> {
  const database = await getDb()
  database.run(sql, params as SqlValue[])
  saveDb()
}

export default getDb
