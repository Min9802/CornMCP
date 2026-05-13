import { createLogger } from '@corn/shared-utils'
import initSqlJs, { type Database } from 'sql.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { createHash } from 'crypto'

const logger = createLogger('mem9')

// ─── Provider metadata + collection naming ──────────────
//
// We isolate vector data per (provider, model) tuple so that swapping the
// embedding backend (e.g. Voyage → LM Studio bge-m3) doesn't pollute the
// existing collection with semantically-incompatible vectors. Two vectors
// of the same dimension from different models live in different latent
// spaces — cosine similarity between them is noise. Per-provider
// collections preserve the old data verbatim and let the admin run an
// explicit re-embed ("sync") when they want a unified searchable corpus.
//
// Naming scheme: `<base>__<provider_slug>__<model_slug>`
//   corn_memories__voyage__voyage_code_3
//   corn_memories__lmstudio__text_embedding_bge_m3
//   corn_memories__openai__text_embedding_3_small
// Double-underscore separator avoids clashing with model names that
// already contain single underscores. Slugs are normalised lowercase
// alphanumeric so Qdrant accepts them (Qdrant collection names allow
// `[a-zA-Z0-9_-]`, max 255 chars; we cap each slug at 64 chars to leave
// headroom).

export type EmbeddingProviderType =
  | 'voyage'
  | 'openai'
  | 'anthropic'
  | 'lmstudio'
  | 'ollama'
  | 'local'
  | 'custom'

export interface EmbeddingProviderInfo {
  /** High-level provider family — used for the UI badge + collection slug. */
  provider: EmbeddingProviderType
  /** Active model identifier as the provider expects it on the wire. */
  model: string
  /** Vector dimensionality — matches Qdrant collection's `vectors.size`. */
  dimensions: number
}

/**
 * Lower-case alpha-numeric slug. Non-alphanumeric runs collapse to a
 * single `_`. Leading/trailing `_` are trimmed. Capped at 64 chars to
 * keep collection names well under Qdrant's 255-char limit even when
 * combined with base + provider.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown'
}

/**
 * Best-effort heuristic: derive provider family from API base URL. Used
 * when callers don't explicitly thread a provider type through (e.g. the
 * env-fallback path in corn-mcp). Falls back to 'custom' for unrecognised
 * hosts so legitimate self-hosted deployments aren't silently mis-tagged
 * as something else.
 */
export function detectProviderType(apiBase: string): EmbeddingProviderType {
  const lower = apiBase.toLowerCase()
  if (lower.includes('voyageai.com')) return 'voyage'
  if (lower.includes('api.openai.com')) return 'openai'
  if (lower.includes('api.anthropic.com')) return 'anthropic'
  // Local providers: match by typical port. LM Studio defaults to 1234,
  // Ollama to 11434. Both expose OpenAI-compat /v1/embeddings.
  if (/:1234(\b|\/)/.test(lower)) return 'lmstudio'
  if (/:11434(\b|\/)/.test(lower)) return 'ollama'
  return 'custom'
}

/**
 * Compose a Qdrant collection name from a base + provider info. The base
 * is typically `<prefix>_memories` or `<prefix>_knowledge`; the result
 * name is stable across restarts as long as provider + model don't move.
 */
export function embeddingCollectionName(
  base: string,
  info: { provider: string; model: string },
): string {
  const providerSlug = slugify(info.provider)
  const modelSlug = slugify(info.model)
  return `${base}__${providerSlug}__${modelSlug}`
}

// ─── Qdrant Client (kept for backward compat) ──────────

interface QdrantPoint {
  id: string
  vector: number[]
  payload: Record<string, unknown>
}

interface QdrantSearchResult {
  id: string
  score: number
  payload: Record<string, unknown>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Convert any caller-supplied string id (e.g. `mem-<hex32>`) into a Qdrant-
 * accepted point id (UUID). Qdrant rejects arbitrary strings — only
 * unsigned ints or RFC4122 UUIDs are valid. We hash the raw id with SHA-1
 * and format the first 16 bytes as a UUIDv5-style identifier so the mapping
 * is deterministic (idempotent re-runs / re-stores) while preserving the
 * original id via `_id_raw` in the payload for round-trip on search.
 *
 * Already-formatted UUID inputs are passed through unchanged so the helper
 * is forward-compatible with callers that adopt UUIDs natively.
 */
export function toQdrantPointId(rawId: string): string {
  if (UUID_RE.test(rawId)) return rawId.toLowerCase()
  const hash = createHash('sha1').update(rawId).digest('hex')
  const verNibble = '5' + hash.slice(13, 16) // version=5
  const variantByte = (
    (parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80
  ) // variant=10xx
    .toString(16)
    .padStart(2, '0')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    verNibble,
    variantByte + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join('-')
}

export class QdrantClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  async ensureCollection(name: string, vectorSize: number = 1536): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/collections/${name}`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) return

      await fetch(`${this.baseUrl}/collections/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vectors: { size: vectorSize, distance: 'Cosine' },
        }),
      })
      logger.info(`Created Qdrant collection: ${name}`)
    } catch (err) {
      logger.error(`Failed to ensure collection ${name}:`, err)
      throw err
    }
  }

  /**
   * Probe a collection without creating it. Returns metadata (vector
   * size + point count) when present, null on 404. Other errors throw.
   * Used by the legacy-collection migration path so we can decide
   * whether to clone, skip, or warn before touching anything.
   */
  async getCollectionInfo(name: string): Promise<{
    name: string
    vectorSize: number
    pointsCount: number
  } | null> {
    const res = await fetch(`${this.baseUrl}/collections/${name}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(`Qdrant getCollection ${name} failed: ${await res.text()}`)
    }
    const data = (await res.json()) as {
      result?: {
        config?: { params?: { vectors?: { size?: number } } }
        points_count?: number
      }
    }
    const vectorSize = data.result?.config?.params?.vectors?.size ?? 0
    const pointsCount = data.result?.points_count ?? 0
    return { name, vectorSize, pointsCount }
  }

  /**
   * Page through every point in a collection. Yields batches as soon as
   * each network call returns so memory stays bounded for large stores.
   * Used by the inline legacy-collection migration to clone raw vectors
   * without re-embedding.
   */
  async *scrollAll(
    collection: string,
    options: { batchSize?: number; withVectors?: boolean; withPayload?: boolean } = {},
  ): AsyncGenerator<
    Array<{ id: string | number; vector?: number[]; payload?: Record<string, unknown> }>,
    void,
    void
  > {
    const batchSize = options.batchSize ?? 250
    const withVectors = options.withVectors ?? true
    const withPayload = options.withPayload ?? true
    let offset: string | number | undefined = undefined

    while (true) {
      const body: Record<string, unknown> = {
        limit: batchSize,
        with_payload: withPayload,
        with_vector: withVectors,
      }
      if (offset !== undefined) body.offset = offset

      const res = await fetch(`${this.baseUrl}/collections/${collection}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        throw new Error(`Qdrant scroll ${collection} failed: ${await res.text()}`)
      }
      const data = (await res.json()) as {
        result?: {
          points?: Array<{
            id: string | number
            vector?: number[] | { [k: string]: number[] }
            payload?: Record<string, unknown>
          }>
          next_page_offset?: string | number | null
        }
      }
      const points = data.result?.points ?? []
      if (points.length === 0) return

      yield points.map((p) => ({
        id: p.id,
        vector: Array.isArray(p.vector) ? p.vector : undefined,
        payload: p.payload,
      }))

      const next = data.result?.next_page_offset
      if (next === null || next === undefined) return
      offset = next
    }
  }

  /**
   * Upsert points using their existing on-wire ids verbatim — no
   * `toQdrantPointId` hash, no `_id_raw` rewrite. Required for the
   * legacy → suffixed migration path where the source already holds
   * UUIDs that need to land in the target unchanged so callers' raw
   * ids round-trip the same way.
   */
  async rawUpsert(
    collection: string,
    points: Array<{ id: string | number; vector: number[]; payload?: Record<string, unknown> }>,
  ): Promise<void> {
    if (points.length === 0) return
    const res = await fetch(`${this.baseUrl}/collections/${collection}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points }),
    })
    if (!res.ok) {
      throw new Error(`Qdrant rawUpsert failed: ${await res.text()}`)
    }
  }

  async upsert(collection: string, points: QdrantPoint[]): Promise<void> {
    // Map caller ids → Qdrant-accepted UUIDs while preserving the raw id
    // in the payload (`_id_raw`) so search results can round-trip back to
    // the original identifier callers persist in their dashboards.
    const wirePoints = points.map((p) => ({
      id: toQdrantPointId(p.id),
      vector: p.vector,
      payload: { ...p.payload, _id_raw: p.id },
    }))
    const res = await fetch(`${this.baseUrl}/collections/${collection}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: wirePoints }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Qdrant upsert failed: ${text}`)
    }
  }

  async search(
    collection: string,
    vector: number[],
    limit: number = 10,
    filter?: Record<string, unknown>,
  ): Promise<QdrantSearchResult[]> {
    const body: Record<string, unknown> = {
      vector,
      limit,
      with_payload: true,
    }
    if (filter) body.filter = filter

    const res = await fetch(`${this.baseUrl}/collections/${collection}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Qdrant search failed: ${text}`)
    }
    const data = (await res.json()) as { result: QdrantSearchResult[] }
    // Restore caller-facing ids from `_id_raw` (set by upsert). Older
    // points without `_id_raw` fall back to the on-wire UUID so searches
    // never throw mid-rollout.
    return data.result.map((r) => ({
      id: typeof r.payload?.['_id_raw'] === 'string' ? (r.payload['_id_raw'] as string) : r.id,
      score: r.score,
      payload: r.payload,
    }))
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    await fetch(`${this.baseUrl}/collections/${collection}/points/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: ids.map(toQdrantPointId) }),
    })
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(3000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

// ─── Embedding Service ──────────────────────────────────

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
  dimensions: number
  /**
   * Self-describe so callers (Mem9Service, /health probe, sync helper)
   * can route data into per-provider collections without re-deriving
   * the active model from URL/env. Stable contract: provider family is
   * one of the slugged enum members; `model` is the provider's exact
   * model id (used as part of the collection slug).
   */
  getProviderInfo(): EmbeddingProviderInfo
}

/**
 * Local hash-based embedding provider — zero external dependencies.
 * Generates deterministic pseudo-embeddings from text using character trigram
 * frequency vectors. Not as accurate as real neural embeddings, but functional
 * for basic similarity matching when no API key is available.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number

  constructor(dimensions: number = 256) {
    this.dimensions = dimensions
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this._hashEmbed(text))
  }

  getProviderInfo(): EmbeddingProviderInfo {
    return { provider: 'local', model: 'hash', dimensions: this.dimensions }
  }

  private _hashEmbed(text: string): number[] {
    const vec = new Float64Array(this.dimensions)
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '')
    const words = normalized.split(/\s+/).filter(Boolean)

    // Character trigram hashing
    for (const word of words) {
      const padded = ` ${word} `
      for (let i = 0; i < padded.length - 2; i++) {
        const trigram = padded.slice(i, i + 3)
        const hash = this._simpleHash(trigram)
        const idx = Math.abs(hash) % this.dimensions
        vec[idx] += hash > 0 ? 1 : -1
      }
    }

    // Word-level hashing for broader semantic signal
    for (const word of words) {
      const hash = this._simpleHash(word)
      const idx = Math.abs(hash) % this.dimensions
      vec[idx] += (hash % 3) - 1
    }

    // L2 normalize
    let norm = 0
    for (let i = 0; i < this.dimensions; i++) {
      norm += vec[i] * vec[i]
    }
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] /= norm
      }
    }

    return Array.from(vec)
  }

  private _simpleHash(s: string): number {
    let hash = 0
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i)
      hash = ((hash << 5) - hash + ch) | 0
    }
    return hash
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number
  private apiKey: string
  private apiBase: string
  private models: string[]
  private currentModelIndex: number
  /** Primary model — never moves once set, so collection naming is stable
   * even after a 429 rotation lifts `currentModelIndex`. */
  private primaryModel: string
  /** Provider family detected from apiBase at construction. Cached so
   * `getProviderInfo()` is a hot pure read. */
  private providerType: EmbeddingProviderType

  /** Current active model name */
  get model(): string {
    return this.models[this.currentModelIndex]
  }

  constructor(
    apiKey: string,
    apiBase: string = 'https://api.openai.com/v1',
    model: string = 'text-embedding-3-small',
    dimensions: number = 1536,
    fallbackModels?: string[],
  ) {
    this.apiKey = apiKey
    this.apiBase = apiBase.replace(/\/$/, '')
    this.dimensions = dimensions
    this.currentModelIndex = 0
    this.primaryModel = model
    this.providerType = detectProviderType(this.apiBase)

    // Build model rotation list: primary model first, then fallbacks (deduped)
    const allModels = [model, ...(fallbackModels || [])]
    this.models = [...new Set(allModels)]
  }

  getProviderInfo(): EmbeddingProviderInfo {
    // Use the primary model — not `currentModelIndex` — so a transient
    // 429 rotation doesn't shuffle data into a different collection.
    return {
      provider: this.providerType,
      model: this.primaryModel,
      dimensions: this.dimensions,
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Try each model in the rotation list
    const startIndex = this.currentModelIndex
    let attempts = 0

    while (attempts < this.models.length) {
      const activeModel = this.models[this.currentModelIndex]
      
      try {
        const result = await this._tryEmbed(texts, activeModel)
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        
        // If rate-limited after all retries, rotate to next model
        if (msg.includes('429') || msg.includes('rate') || msg.includes('RPM')) {
          const nextIndex = (this.currentModelIndex + 1) % this.models.length
          
          if (nextIndex === startIndex) {
            // We've tried all models and they're all rate-limited
            throw new Error(
              `All ${this.models.length} models rate-limited. Models tried: ${this.models.join(', ')}. Last error: ${msg}`
            )
          }

          console.error(
            `[corn-mem9] ⚡ Model ${activeModel} rate-limited → rotating to ${this.models[nextIndex]}`
          )
          this.currentModelIndex = nextIndex
          attempts++
          continue
        }

        // Non rate-limit errors should still throw immediately
        throw err
      }
    }

    throw new Error(`All ${this.models.length} models exhausted`)
  }

  /** Try a single model with exponential backoff retries */
  private async _tryEmbed(texts: string[], model: string): Promise<number[][]> {
    let retries = 3
    let delay = 2000

    while (retries >= 0) {
      const res = await fetch(`${this.apiBase}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: texts, model }),
      })

      if (res.ok) {
        const data = (await res.json()) as { data: { embedding: number[] }[] }
        const vectors = data.data.map((d) => d.embedding)
        // Fail-fast on dim mismatch: if a rotated/misconfigured model returns
        // a different dim than what callers (and downstream Qdrant collections)
        // expect, surface it here with a clear message instead of letting the
        // raw vectors propagate and failing later inside Qdrant with the
        // opaque "Wrong input: Vector dimension error" response.
        const actualDim = vectors[0]?.length ?? 0
        if (actualDim !== this.dimensions) {
          throw new Error(
            `Embedding dim mismatch: model=${model} returned ${actualDim}, expected ${this.dimensions}. ` +
              `Check MEM9_EMBEDDING_MODEL/MEM9_EMBEDDING_DIMS and MEM9_FALLBACK_MODELS — every fallback model must output the same dimension as the primary.`,
          )
        }
        return vectors
      }

      const text = await res.text()
      
      // Retry on 429 within this model's retry budget
      if (res.status === 429 && retries > 0) {
        console.error(`[corn-mem9] ⏳ ${model} rate-limited, retry in ${delay}ms (${retries} left)`)
        retries--
        await new Promise((r) => setTimeout(r, delay))
        delay *= 2
        continue
      }
      
      throw new Error(`Embedding API failed (${model}): ${text}`)
    }
    throw new Error(`Embedding API failed after retries (${model})`)
  }
}


// ─── SQLite Vector Store (replaces Qdrant) ──────────────

interface VectorRecord {
  id: string
  vector: number[]
  payload: Record<string, unknown>
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

export class SQLiteVectorStore {
  private db: Database | null = null
  private dbPath: string
  private initPromise: Promise<void> | null = null

  constructor(dbPath: string = './data/mem9-vectors.db') {
    this.dbPath = dbPath
  }

  private async ensureDb(): Promise<Database> {
    if (this.db) return this.db

    if (!this.initPromise) {
      this.initPromise = this._initDb()
    }
    await this.initPromise
    return this.db!
  }

  private async _initDb(): Promise<void> {
    const SQL = await initSqlJs()

    // Ensure directory exists
    const dir = dirname(this.dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // Load existing DB or create new
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath)
      this.db = new SQL.Database(buffer)
    } else {
      this.db = new SQL.Database()
    }

    // Create tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        vector BLOB NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_vectors_collection ON vectors(collection)
    `)

    this._save()
    logger.info(`SQLite vector store initialized at ${this.dbPath}`)
  }

  private _save(): void {
    if (!this.db) return
    const data = this.db.export()
    const buffer = Buffer.from(data)
    writeFileSync(this.dbPath, buffer)
  }

  async upsert(collection: string, id: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    const db = await this.ensureDb()
    const vectorBlob = Buffer.from(new Float32Array(vector).buffer)
    const payloadJson = JSON.stringify(payload)

    db.run(
      `INSERT OR REPLACE INTO vectors (id, collection, vector, payload) VALUES (?, ?, ?, ?)`,
      [id, collection, vectorBlob, payloadJson],
    )
    this._save()
  }

  async search(
    collection: string,
    queryVector: number[],
    limit: number = 10,
    filter?: Record<string, unknown>,
  ): Promise<{ id: string; score: number; payload: Record<string, unknown> }[]> {
    const db = await this.ensureDb()

    const results = db.exec(`SELECT id, vector, payload FROM vectors WHERE collection = ?`, [collection])
    if (!results.length || !results[0].values.length) return []

    const scored: { id: string; score: number; payload: Record<string, unknown> }[] = []

    for (const row of results[0].values) {
      const id = row[0] as string
      const vectorBuf = row[1] as Uint8Array
      const payloadStr = row[2] as string

      const storedVector = Array.from(new Float32Array(vectorBuf.buffer, vectorBuf.byteOffset, vectorBuf.byteLength / 4))
      const payload = JSON.parse(payloadStr) as Record<string, unknown>

      // Apply filters
      if (filter) {
        let match = true
        for (const [key, value] of Object.entries(filter)) {
          if (payload[key] !== value) {
            match = false
            break
          }
        }
        if (!match) continue
      }

      const score = cosineSimilarity(queryVector, storedVector)
      scored.push({ id, score, payload })
    }

    // Sort by score descending and limit
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    const db = await this.ensureDb()
    const placeholders = ids.map(() => '?').join(',')
    db.run(`DELETE FROM vectors WHERE collection = ? AND id IN (${placeholders})`, [collection, ...ids])
    this._save()
  }

  async health(): Promise<boolean> {
    try {
      await this.ensureDb()
      return true
    } catch {
      return false
    }
  }
}

// ─── Mem9 Service (original — uses Qdrant) ──────────────

export interface Mem9Options {
  /** Base name shared by memory + knowledge collections. Defaults to `corn`,
   * yielding `corn_memories` / `corn_knowledge` as legacy bases — the
   * dynamic suffix `__<provider>__<model>` is appended at init() time. */
  collectionPrefix?: string
}

export class Mem9Service {
  private qdrant: QdrantClient
  private embedder: EmbeddingProvider
  private collectionPrefix: string
  /** Resolved during init(): `<prefix>_memories__<provider>__<model>`. */
  private memoryCollection!: string
  /** Resolved during init(): `<prefix>_knowledge__<provider>__<model>`. */
  private knowledgeCollection!: string

  constructor(qdrantUrl: string, embedder: EmbeddingProvider, options: Mem9Options = {}) {
    this.qdrant = new QdrantClient(qdrantUrl)
    this.embedder = embedder
    this.collectionPrefix = options.collectionPrefix ?? 'corn'
  }

  /** Resolved collection names — useful for /health, sync helpers, audit. */
  getCollectionNames(): { memories: string; knowledge: string } {
    return { memories: this.memoryCollection, knowledge: this.knowledgeCollection }
  }

  async init(): Promise<void> {
    const info = this.embedder.getProviderInfo()
    const memBase = `${this.collectionPrefix}_memories`
    const kbBase = `${this.collectionPrefix}_knowledge`
    this.memoryCollection = embeddingCollectionName(memBase, info)
    this.knowledgeCollection = embeddingCollectionName(kbBase, info)

    // Inline legacy migration: if we still have unsuffixed `corn_memories`
    // / `corn_knowledge` collections from before this refactor, clone
    // their points into the suffixed equivalent for the *current* embedder
    // when dim matches (raw copy, no re-embed). Mismatched dim → leave
    // legacy untouched + log a warning so the admin can run an explicit
    // sync (re-embed) later. Idempotent: skips when suffixed already
    // exists.
    await this._migrateLegacyIfNeeded(memBase, this.memoryCollection, info.dimensions)
    await this._migrateLegacyIfNeeded(kbBase, this.knowledgeCollection, info.dimensions)

    await this.qdrant.ensureCollection(this.memoryCollection, info.dimensions)
    await this.qdrant.ensureCollection(this.knowledgeCollection, info.dimensions)
    logger.info(
      `Mem9 collections initialized: memories=${this.memoryCollection} knowledge=${this.knowledgeCollection} (dim=${info.dimensions})`,
    )
  }

  /**
   * One-shot legacy migration helper. Runs at every init() but is
   * idempotent (skips when the suffixed target already exists). Clones
   * raw vectors verbatim — same dim guarantees they're directly
   * compatible without re-embedding.
   */
  private async _migrateLegacyIfNeeded(
    legacyName: string,
    suffixedName: string,
    currentDim: number,
  ): Promise<void> {
    const [legacy, suffixed] = await Promise.all([
      this.qdrant.getCollectionInfo(legacyName),
      this.qdrant.getCollectionInfo(suffixedName),
    ])

    if (!legacy) return // No legacy collection → fresh install, nothing to migrate.
    if (suffixed) return // Already migrated previously, idempotent.

    if (legacy.vectorSize !== currentDim) {
      logger.warn(
        `Legacy ${legacyName} has dim=${legacy.vectorSize} but current embedder is dim=${currentDim}; ` +
          `skipping inline migration — use the embedding-sync helper to re-embed when ready. ` +
          `Legacy data is preserved untouched at ${legacyName}.`,
      )
      return
    }

    logger.info(
      `Migrating legacy ${legacyName} (${legacy.pointsCount} points, dim=${legacy.vectorSize}) → ${suffixedName} via raw vector clone`,
    )
    await this.qdrant.ensureCollection(suffixedName, currentDim)

    let copied = 0
    for await (const batch of this.qdrant.scrollAll(legacyName, {
      batchSize: 250,
      withVectors: true,
      withPayload: true,
    })) {
      const points = batch
        .filter((p) => Array.isArray(p.vector))
        .map((p) => ({
          id: p.id,
          vector: p.vector!,
          payload: p.payload ?? {},
        }))
      if (points.length > 0) {
        await this.qdrant.rawUpsert(suffixedName, points)
        copied += points.length
      }
    }
    logger.info(`Migrated ${copied}/${legacy.pointsCount} points → ${suffixedName}`)
  }

  async storeMemory(
    id: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const [vector] = await this.embedder.embed([content])
    await this.qdrant.upsert(this.memoryCollection, [
      { id, vector, payload: { content, ...metadata, stored_at: new Date().toISOString() } },
    ])
  }

  async searchMemory(
    query: string,
    limit: number = 10,
    filter?: Record<string, unknown>,
  ): Promise<QdrantSearchResult[]> {
    const [vector] = await this.embedder.embed([query])
    const qdrantFilter = filter
      ? { must: Object.entries(filter).map(([key, value]) => ({ key, match: { value } })) }
      : undefined
    return this.qdrant.search(this.memoryCollection, vector, limit, qdrantFilter)
  }

  async storeKnowledge(
    id: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const [vector] = await this.embedder.embed([content])
    await this.qdrant.upsert(this.knowledgeCollection, [
      { id, vector, payload: { content, ...metadata, stored_at: new Date().toISOString() } },
    ])
  }

  async searchKnowledge(
    query: string,
    limit: number = 10,
    filter?: Record<string, unknown>,
  ): Promise<QdrantSearchResult[]> {
    const [vector] = await this.embedder.embed([query])
    const qdrantFilter = filter
      ? { must: Object.entries(filter).map(([key, value]) => ({ key, match: { value } })) }
      : undefined
    return this.qdrant.search(this.knowledgeCollection, vector, limit, qdrantFilter)
  }

  async health(): Promise<boolean> {
    return this.qdrant.health()
  }
}

// ─── LocalMem9Service (uses SQLite — no Docker!) ────────

export class LocalMem9Service {
  private store: SQLiteVectorStore
  private embedder: EmbeddingProvider

  constructor(embedder: EmbeddingProvider, dbPath?: string) {
    this.store = new SQLiteVectorStore(dbPath)
    this.embedder = embedder
  }

  async storeMemory(
    id: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const [vector] = await this.embedder.embed([content])
    await this.store.upsert('corn_memories', id, vector, {
      content,
      ...metadata,
      stored_at: new Date().toISOString(),
    })
  }

  async searchMemory(
    query: string,
    limit: number = 10,
    filter?: Record<string, unknown>,
  ): Promise<{ id: string; score: number; payload: Record<string, unknown> }[]> {
    const [vector] = await this.embedder.embed([query])
    return this.store.search('corn_memories', vector, limit, filter)
  }

  async storeKnowledge(
    id: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const [vector] = await this.embedder.embed([content])
    await this.store.upsert('corn_knowledge', id, vector, {
      content,
      ...metadata,
      stored_at: new Date().toISOString(),
    })
  }

  async searchKnowledge(
    query: string,
    limit: number = 10,
    filter?: Record<string, unknown>,
  ): Promise<{ id: string; score: number; payload: Record<string, unknown> }[]> {
    const [vector] = await this.embedder.embed([query])
    return this.store.search('corn_knowledge', vector, limit, filter)
  }

  async health(): Promise<boolean> {
    return this.store.health()
  }
}

export { QdrantClient as default }
