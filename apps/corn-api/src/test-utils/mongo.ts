// Test helper that spins up an in-memory replica-set MongoDB so
// integration tests can hit Mongoose Models without a host service.
//
// We use a single-node replica set (count=1) on purpose: it lets the
// transaction-aware code paths run as they will in production (Project
// cascade middleware wraps a `session.withTransaction()`). On standalone
// Mongo `supportsTransactions()` returns false and the cascade falls back
// to a non-atomic fan-out — that path is also valid but we prefer to
// exercise the replica-set branch in tests.
//
// Usage:
//   const mongo = await setupTestMongo()
//   ...tests...
//   await teardownTestMongo(mongo)
//
// The first call downloads ~50MB of mongod binary into
// `~/.cache/mongodb-binaries/` (single-machine cache shared across runs).

import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { connectMongoose, disconnectMongoose } from '../db/mongoose/connection.js'
import { initSchemas } from '../db/mongoose/init.js'

export async function setupTestMongo(): Promise<MongoMemoryReplSet> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: '7.0.14' },
  })
  const uri = replSet.getUri()
  await connectMongoose(uri)
  await initSchemas()
  return replSet
}

export async function teardownTestMongo(replSet: MongoMemoryReplSet): Promise<void> {
  await disconnectMongoose()
  await replSet.stop()
}

/** Wipe every collection between tests without dropping indexes. */
export async function clearAllCollections(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return
  const collections = mongoose.connection.collections
  await Promise.all(
    Object.values(collections).map((c) => c.deleteMany({})),
  )
}
