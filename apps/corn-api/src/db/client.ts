import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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

  // Run schema
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8')
    db.run(schema)
    saveDb()
    logger.info(`Database initialized at ${dbPath}`)
  } catch (err) {
    logger.error('Failed to initialize schema:', err)
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
