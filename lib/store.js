// Shared state for the Vercel deployment, kept in Postgres (Neon free tier via
// the Vercel Storage integration). The tables are created on first use.
//
//   keys    one row per pairing key: the e-reader's user agent and when it was made
//   files   books sent to a key; ready = the one the e-reader is offered
//   chunks  the file contents in pieces small enough for one function request
//
// Vercel caps a function's request body at 4.5 MB, so the upload page sends a
// book in chunks and the e-reader's download streams them back out.
const crypto = require('crypto')
const { Pool } = require('pg')

const maxKeyAge = 60 * 60 * 1000  // a key lasts 1 hour
const maxFileAge = 60 * 60 * 1000  // files are deleted after 1 hour at most
const downloadedGrace = 5 * 60 * 1000  // and 5 minutes after the e-reader downloads them

const keyChars = '23456789ACDEFGHJKLMNPRSTUVWXYZ'
const keyLength = 4

// Neon's Vercel integration sets DATABASE_URL and POSTGRES_URL, possibly with
// a custom prefix (e.g. STORAGE_DATABASE_URL).
function connectionString () {
  const env = process.env
  if (env.DATABASE_URL) return env.DATABASE_URL
  if (env.POSTGRES_URL) return env.POSTGRES_URL
  const names = Object.keys(env).sort()
  const name = names.find((n) => /DATABASE_URL$/.test(n) && !/UNPOOLED/.test(n) && env[n]) ||
    names.find((n) => /POSTGRES_URL$/.test(n) && env[n])
  if (name) return env[name]
  throw new Error('No database found. Connect a Neon Postgres database to the Vercel project.')
}

let pool = null
let ready = null

function db () {
  if (!pool) {
    const url = connectionString()
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /host=\/|@\//.test(url)
    pool = new Pool({
      connectionString: url,
      ssl: local ? false : { rejectUnauthorized: true },
      max: 3,
      idleTimeoutMillis: 10000
    })
    pool.on('error', (err) => console.error('Postgres pool error', err))
    try {
      // Lets Vercel close idle connections before a function instance is frozen
      require('@vercel/functions').attachDatabasePool(pool)
    } catch (err) {}
  }
  return pool
}

async function query (text, params) {
  if (!ready) {
    ready = db().query(`
      CREATE TABLE IF NOT EXISTS keys (
        key text PRIMARY KEY,
        agent text NOT NULL,
        created timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS files (
        id text PRIMARY KEY,
        key text NOT NULL REFERENCES keys ON DELETE CASCADE,
        name text NOT NULL DEFAULT '',
        content_type text NOT NULL DEFAULT 'application/octet-stream',
        size bigint NOT NULL DEFAULT 0,
        ready boolean NOT NULL DEFAULT false,
        created timestamptz NOT NULL DEFAULT now(),
        downloaded timestamptz
      );
      CREATE INDEX IF NOT EXISTS files_key ON files (key);
      CREATE TABLE IF NOT EXISTS chunks (
        file_id text NOT NULL REFERENCES files ON DELETE CASCADE,
        seq integer NOT NULL,
        data bytea NOT NULL,
        PRIMARY KEY (file_id, seq)
      );
    `).catch((err) => {
      ready = null
      throw err
    })
  }
  await ready
  return db().query(text, params)
}

function randomKey () {
  let key = ''
  for (let i = 0; i < keyLength; i++) {
    key += keyChars[crypto.randomInt(keyChars.length)]
  }
  return key
}

function normalizeKey (key) {
  return String(key || '').trim().toUpperCase()
}

function validKey (key) {
  return /^[A-Z0-9]{4}$/.test(key)
}

async function createKey (agent) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = randomKey()
    // An expired key can be reused; cleanup() normally removes those first
    const result = await query(
      `INSERT INTO keys (key, agent) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET agent = EXCLUDED.agent, created = now()
       WHERE keys.created < now() - $3 * interval '1 millisecond'
       RETURNING key`,
      [key, agent, maxKeyAge])
    if (result.rowCount === 1) {
      // A reused key starts with no files
      await query('DELETE FROM files WHERE key = $1', [key])
      return key
    }
  }
  return null
}

// Returns { agent, created, file } for a key younger than an hour, or null.
// file is the book waiting for the e-reader: { id, name, contentType, size }.
async function getKey (key) {
  key = normalizeKey(key)
  if (!validKey(key)) return null
  const result = await query(
    `SELECT k.agent, k.created, f.id, f.name, f.content_type, f.size
     FROM keys k LEFT JOIN files f ON f.key = k.key AND f.ready
     WHERE k.key = $1 AND k.created > now() - $2 * interval '1 millisecond'
     ORDER BY f.created DESC LIMIT 1`,
    [key, maxKeyAge])
  const row = result.rows[0]
  if (!row) return null
  return {
    agent: row.agent,
    created: row.created,
    file: row.id ? { id: row.id, name: row.name, contentType: row.content_type, size: Number(row.size) } : null
  }
}

// Removes a key and its books, e.g. when the e-reader asks for a new key
async function removeKey (key) {
  await query('DELETE FROM keys WHERE key = $1', [normalizeKey(key)])
}

// Starts an upload for a key and returns its id, which the upload page uses
// to send chunks. The id is random, so only the uploader knows it.
async function createUpload (key) {
  const id = crypto.randomBytes(16).toString('hex')
  await query('INSERT INTO files (id, key) VALUES ($1, $2)', [id, normalizeKey(key)])
  return id
}

// The upload page sends chunks in order; a resent chunk replaces the old one.
// Returns the upload's total size so far, or null if the upload doesn't exist.
async function addChunk (id, seq, data, maxSize) {
  const result = await query(
    `WITH f AS (SELECT id FROM files WHERE id = $1 AND NOT ready),
     c AS (
       INSERT INTO chunks (file_id, seq, data) SELECT id, $2, $3 FROM f
       ON CONFLICT (file_id, seq) DO UPDATE SET data = EXCLUDED.data
       RETURNING file_id
     )
     SELECT (SELECT count(*) FROM c) AS added,
       COALESCE((SELECT sum(length(data)) FROM chunks WHERE file_id = $1 AND seq <> $2), 0) + $4 AS size`,
    [id, seq, data, data.length])
  const row = result.rows[0]
  if (!row || Number(row.added) !== 1) return null
  const size = Number(row.size)
  if (size > maxSize) {
    await deleteFile(id)
    return null
  }
  return size
}

// Returns { id, key, ready } for an upload, or null
async function getUpload (id) {
  if (!/^[0-9a-f]{32}$/.test(String(id || ''))) return null
  const result = await query('SELECT id, key, ready FROM files WHERE id = $1', [id])
  return result.rows[0] || null
}

// Calls onChunk(buffer) for each chunk of a file, in order, one at a time so a
// large book never has to fit in memory.
async function readChunks (id, onChunk) {
  const result = await query('SELECT seq FROM chunks WHERE file_id = $1 ORDER BY seq', [id])
  for (const { seq } of result.rows) {
    const chunk = await query('SELECT data FROM chunks WHERE file_id = $1 AND seq = $2', [id, seq])
    if (!chunk.rows[0]) throw new Error('File was deleted while reading it')
    await onChunk(chunk.rows[0].data)
  }
}

// Stores a finished file (e.g. a converted book) from a readable stream
async function writeFile (key, stream, chunkSize) {
  const id = await createUpload(key)
  let seq = 0
  let pending = []
  let pendingSize = 0
  const flush = async () => {
    if (pendingSize === 0) return
    await query('INSERT INTO chunks (file_id, seq, data) VALUES ($1, $2, $3)', [id, seq++, Buffer.concat(pending)])
    pending = []
    pendingSize = 0
  }
  for await (const piece of stream) {
    pending.push(piece)
    pendingSize += piece.length
    if (pendingSize >= chunkSize) await flush()
  }
  await flush()
  return id
}

// Makes a file the one the e-reader is offered, replacing any earlier book
async function setReady (key, id, { name, contentType, size }) {
  key = normalizeKey(key)
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM files WHERE key = $1 AND ready', [key])
    await client.query(
      'UPDATE files SET ready = true, name = $3, content_type = $4, size = $5 WHERE id = $1 AND key = $2',
      [id, key, name, contentType, size])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function markDownloaded (id) {
  await query('UPDATE files SET downloaded = now() WHERE id = $1 AND downloaded IS NULL', [id])
}

async function deleteFile (id) {
  if (!id) return
  try {
    await query('DELETE FROM files WHERE id = $1', [id])
  } catch (err) {
    console.error('Failed to delete file', id, err)
  }
}

// Deletes expired keys, books downloaded more than 5 minutes ago, and anything
// older than an hour. Returns how many files were removed.
async function cleanup () {
  const files = await query(
    `DELETE FROM files
     WHERE created < now() - $1 * interval '1 millisecond'
       OR downloaded < now() - $2 * interval '1 millisecond'
       OR key IN (SELECT key FROM keys WHERE created < now() - $3 * interval '1 millisecond')`,
    [maxFileAge, downloadedGrace, maxKeyAge])
  await query(`DELETE FROM keys WHERE created < now() - $1 * interval '1 millisecond'`, [maxKeyAge])
  return files.rowCount
}

// For requests that come often (the e-reader's poll), clean up at most once a
// minute per function instance.
let lastCleanup = 0
async function cleanupSometimes () {
  if (Date.now() - lastCleanup < 60 * 1000) return
  lastCleanup = Date.now()
  try {
    const removed = await cleanup()
    if (removed) console.log('Removed', removed, 'old file(s)')
  } catch (err) {
    console.error('Cleanup failed', err)
  }
}

module.exports = {
  normalizeKey,
  validKey,
  createKey,
  getKey,
  removeKey,
  createUpload,
  addChunk,
  getUpload,
  readChunks,
  writeFile,
  setReady,
  markDownloaded,
  deleteFile,
  cleanup,
  cleanupSometimes,
  end: () => pool && pool.end()
}
