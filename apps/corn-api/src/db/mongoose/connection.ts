// ─── Mongoose connection layer ─────────────────────────────
// Single shared `mongoose` instance for the corn-api process. Idempotent —
// re-calling `connectMongoose()` is a no-op once we've established a live
// connection. Caller modules import Mongoose Models directly (defined in
// `./schemas/*.ts`); this file only owns the connection lifecycle.
//
// Why these driver options:
//   - autoIndex: false  → indexes are built explicitly via `init.ts` so we
//     control ordering (required when seed data races schema migrations).
//   - serverSelectionTimeoutMS: 5000 → keep startup fast-fail on a
//     misconfigured MONGODB_URI rather than hanging the readiness probe.
//   - socketTimeoutMS: 45000 → tolerate long aggregations / large
//     `bulkWrite` migration batches.
//
// Replica set: caller env (MONGODB_URI=...?replicaSet=rs0) determines this.
// Mongoose drives transactions through the URI replica set spec; nothing to
// configure here.

import mongoose from 'mongoose'
import { createLogger } from '@corn/shared-utils'

const logger = createLogger('mongoose')

let connected = false
let transactionsSupported: boolean | null = null

export async function connectMongoose(uri: string): Promise<typeof mongoose> {
  if (connected) return mongoose

  mongoose.set('strictQuery', true)

  await mongoose.connect(uri, {
    autoIndex: false,
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })

  mongoose.connection.on('error', (err) => {
    logger.error('Connection error:', err)
  })
  mongoose.connection.on('disconnected', () => {
    logger.warn('Disconnected')
    connected = false
    transactionsSupported = null
  })
  mongoose.connection.on('reconnected', () => {
    logger.info('Reconnected')
    connected = true
    transactionsSupported = null // re-probe on reconnect
  })

  connected = true
  logger.info(`Connected to ${redactUri(uri)}`)

  // Probe topology so callers (Project cascade middleware, etc.) can branch
  // safely: standalone Mongo rejects multi-document transactions with
  // `IllegalOperation: Transaction numbers are only allowed on a replica set`.
  await probeTransactionSupport()
  return mongoose
}

async function probeTransactionSupport(): Promise<void> {
  try {
    const adminDb = mongoose.connection.db?.admin()
    if (!adminDb) {
      transactionsSupported = false
      return
    }
    await adminDb.command({ replSetGetStatus: 1 })
    transactionsSupported = true
    logger.info('Replica set detected — multi-document transactions enabled')
  } catch (err) {
    const codeName = (err as { codeName?: string })?.codeName
    if (codeName === 'NoReplicationEnabled' || codeName === 'NotYetInitialized') {
      transactionsSupported = false
      logger.warn(
        'Standalone MongoDB detected — multi-document transactions disabled. ' +
          'Cascading deletes will run non-atomically; partial failures may leave orphan rows.',
      )
    } else {
      // Unknown error — be conservative and disable.
      transactionsSupported = false
      logger.warn(`replSetGetStatus probe failed (${codeName ?? 'unknown'}): transactions disabled`)
    }
  }
}

/**
 * True iff the connected MongoDB deployment supports multi-document
 * transactions (replica set or sharded). Returns `false` for standalone
 * deployments. Callers SHOULD branch around `session.withTransaction()`
 * usage based on this flag instead of catching errors after the fact.
 */
export function supportsTransactions(): boolean {
  return transactionsSupported === true
}

export async function disconnectMongoose(): Promise<void> {
  if (!connected) return
  await mongoose.disconnect()
  connected = false
}

/** Return the live mongoose instance. Throws if not connected. */
export function getMongoose(): typeof mongoose {
  if (!connected) {
    throw new Error('Mongoose not connected — call connectMongoose() first')
  }
  return mongoose
}

export function isMongooseConnected(): boolean {
  return connected && mongoose.connection.readyState === 1
}

// Strip the password from a Mongo URI for safe logging:
//   mongodb://cornhub:secret@host:27017/db → mongodb://cornhub:***@host:27017/db
function redactUri(uri: string): string {
  return uri.replace(/(\/\/[^:]+:)[^@]+(@)/, '$1***$2')
}
