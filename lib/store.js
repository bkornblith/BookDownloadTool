// Shared state for the Vercel deployment, kept entirely in Vercel Blob.
//
// Each pairing key has a folder keys/<id>/ where <id> is an HMAC of the key, so
// the public URLs can't be guessed from the key itself:
//   info.json  written once when the key is made: { created, agent }
//   file.json  the book waiting for the e-reader: { name, url }
// Books live under books/<random>/<filename>.
//
// Blob operations are metered (Hobby includes 10,000 simple and 2,000 advanced
// a month, and Blob stops working for 30 days past that), so the e-reader's
// poll costs one head() and nothing else, and listing only happens on cleanup.
const crypto = require('crypto')
const { put, head, get, del, list, BlobNotFoundError } = require('@vercel/blob')

// The Blob token can also get a custom prefix when the store is connected;
// @vercel/blob only reads BLOB_READ_WRITE_TOKEN.
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  const name = Object.keys(process.env).sort().find((n) => (process.env[n] || '').startsWith('vercel_blob_rw_'))
  if (name) process.env.BLOB_READ_WRITE_TOKEN = process.env[name]
}

const maxKeyAge = 60 * 60 * 1000  // a key lasts 1 hour
const maxBlobAge = 60 * 60 * 1000  // uploaded files are deleted after 1 hour

const keyChars = '23456789ACDEFGHJKLMNPRSTUVWXYZ'
const keyLength = 4

function randomKey () {
  let key = ''
  for (let i = 0; i < keyLength; i++) {
    key += keyChars[Math.floor(Math.random() * keyChars.length)]
  }
  return key
}

function normalizeKey (key) {
  return String(key || '').trim().toUpperCase()
}

function keyFolder (key) {
  const secret = process.env.BLOB_READ_WRITE_TOKEN
  if (!secret) throw new Error('No Blob token found. Connect a Blob store to the Vercel project.')
  const id = crypto.createHmac('sha256', secret).update(normalizeKey(key)).digest('hex').slice(0, 32)
  return 'keys/' + id + '/'
}

async function readJSON (urlOrPathname) {
  const result = await get(urlOrPathname, { access: 'public' })
  if (!result || result.statusCode !== 200) return null
  const text = await new Response(result.stream).text()
  return { data: JSON.parse(text), etag: result.blob.etag }
}

async function writeJSON (pathname, data, options) {
  return put(pathname, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    ...options
  })
}

async function createKey (agent) {
  const info = { created: Date.now(), agent }
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = randomKey()
    try {
      // info.json never changes, so it can stay in the CDN cache
      await writeJSON(keyFolder(key) + 'info.json', info, { allowOverwrite: false })
      return key
    } catch (err) {
      if (!/exist/i.test(err.message)) throw err
    }
  }
  return null
}

// Returns { created, agent } for a key younger than an hour, or null. The
// e-reader's poll reads info.json from the CDN for free; pass fresh to also
// check with head() that the key wasn't released in the last minute.
async function getKey (key, { fresh = false } = {}) {
  key = normalizeKey(key)
  if (!/^[A-Z0-9]{4}$/.test(key)) return null
  const pathname = keyFolder(key) + 'info.json'
  if (fresh) {
    try {
      await head(pathname)
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null
      throw err
    }
  }
  const result = await readJSON(pathname)
  if (!result) return null
  const info = result.data
  if (Date.now() - info.created > maxKeyAge) return null
  return info
}

// The book waiting for this key: { name, url }, or null. head() always sees
// the latest file.json, but the CDN can serve an older copy for a minute after
// it's overwritten, so the content is only trusted when its ETag matches.
async function getFile (key) {
  let meta
  try {
    meta = await head(keyFolder(key) + 'file.json')
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null
    throw err
  }
  const etag = bareEtag(meta.etag)
  const url = new URL(meta.url)
  url.searchParams.set('v', etag)
  const result = await readJSON(url.href)
  if (!result) return null
  if (etag && result.etag && bareEtag(result.etag) !== etag) return null
  return result.data
}

function bareEtag (etag) {
  return String(etag || '').replace(/^W\//, '').replace(/"/g, '')
}

async function setFile (key, file) {
  await writeJSON(keyFolder(key) + 'file.json', file, { allowOverwrite: true, cacheControlMaxAge: 60 })
}

// Deletes are free, so this is used generously
async function deleteBlob (url) {
  if (!url) return
  try {
    await del(url)
  } catch (err) {
    console.error('Failed to delete blob', url, err)
  }
}

// Removes a key and its book, e.g. when the e-reader asks for a new key
async function removeKey (key) {
  const file = await getFile(key).catch(() => null)
  if (file) await deleteBlob(file.url)
  await deleteBlob([keyFolder(key) + 'info.json', keyFolder(key) + 'file.json'])
}

// Deletes keys, books and unfinished uploads older than an hour. One list()
// covers the whole store, which only ever holds a handful of files.
async function cleanup () {
  const cutoff = Date.now() - maxBlobAge
  const blobs = []
  let cursor
  do {
    const page = await list({ cursor, limit: 1000 })
    blobs.push(...page.blobs)
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)

  const expiredKeys = new Set()
  for (const blob of blobs) {
    if (/^keys\/[0-9a-f]+\/info\.json$/.test(blob.pathname) && new Date(blob.uploadedAt).getTime() < cutoff) {
      expiredKeys.add(blob.pathname.split('/')[1])
    }
  }
  const old = blobs.filter((blob) => {
    if (blob.pathname.startsWith('keys/')) return expiredKeys.has(blob.pathname.split('/')[1])
    return new Date(blob.uploadedAt).getTime() < cutoff
  }).map((blob) => blob.url)
  if (old.length > 0) await del(old)
  return old.length
}

module.exports = {
  normalizeKey,
  createKey,
  getKey,
  getFile,
  setFile,
  removeKey,
  deleteBlob,
  cleanup
}
