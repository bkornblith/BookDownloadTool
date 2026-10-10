// Shared state for the Vercel deployment. Pairing keys live in Redis so every
// function instance sees the same keys; files live in Vercel Blob.
const { createClient } = require('redis')
const { del, list } = require('@vercel/blob')

const keyTTL = 60  // seconds a key survives without the e-reader polling it
const maxKeyAge = 60 * 60 * 1000  // hard limit of 1 hour per key
const maxBlobAge = 60 * 60 * 1000  // uploaded files are deleted after 1 hour

const keyChars = '23456789ACDEFGHJKLMNPRSTUVWXYZ'
const keyLength = 4

let clientPromise = null

function redis () {
  if (!clientPromise) {
    const url = process.env.REDIS_URL || process.env.KV_URL
    if (!url) throw new Error('REDIS_URL is not set. Add a Redis database to the Vercel project.')
    const client = createClient({ url })
    client.on('error', (err) => console.error('Redis error', err))
    clientPromise = client.connect().then(() => client, (err) => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

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

async function createKey (agent) {
  const r = await redis()
  const info = { created: Date.now(), agent, file: null, urls: [] }
  for (let attempt = 0; attempt < 50; attempt++) {
    const key = randomKey()
    const ok = await r.set('key:' + key, JSON.stringify(info), { NX: true, EX: keyTTL })
    if (ok) return key
  }
  return null
}

async function getKey (key) {
  key = normalizeKey(key)
  if (!key) return null
  const r = await redis()
  const raw = await r.get('key:' + key)
  if (!raw) return null
  const info = JSON.parse(raw)
  if (Date.now() - info.created > maxKeyAge) {
    await removeKey(key, info)
    return null
  }
  return info
}

// Keeps the key alive while the e-reader is still polling it. Only the expiry
// is refreshed so a poll can't overwrite a file that was just uploaded.
async function touchKey (key) {
  const r = await redis()
  await r.expire('key:' + normalizeKey(key), keyTTL)
}

async function saveKey (key, info) {
  const r = await redis()
  await r.set('key:' + normalizeKey(key), JSON.stringify(info), { EX: keyTTL })
}

async function removeKey (key, info) {
  const r = await redis()
  await r.del('key:' + normalizeKey(key))
  if (info && info.file) await deleteBlob(info.file.url)
}

// Every blob we create is tracked so it can be removed even when its key
// simply expires in Redis.
async function trackBlob (url) {
  const r = await redis()
  await r.zAdd('blobs', { score: Date.now(), value: url })
}

async function deleteBlob (url) {
  if (!url) return
  try {
    await del(url)
  } catch (err) {
    console.error('Failed to delete blob', url, err)
  }
  const r = await redis()
  await r.zRem('blobs', url)
}

async function cleanupBlobs () {
  const r = await redis()
  const old = await r.zRangeByScore('blobs', 0, Date.now() - maxBlobAge)
  if (old.length === 0) return 0
  try {
    await del(old)
  } catch (err) {
    console.error('Failed to delete old blobs', err)
    return 0
  }
  await r.zRem('blobs', old)
  return old.length
}

// Uploads the browser started but never finished are not tracked in Redis
async function cleanupUploads () {
  const cutoff = Date.now() - maxBlobAge
  const old = []
  let cursor
  do {
    const page = await list({ prefix: 'uploads/', cursor })
    for (const blob of page.blobs) {
      if (new Date(blob.uploadedAt).getTime() < cutoff) old.push(blob.url)
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  if (old.length > 0) await del(old)
  return old.length
}

module.exports = {
  normalizeKey,
  createKey,
  getKey,
  touchKey,
  saveKey,
  removeKey,
  trackBlob,
  deleteBlob,
  cleanupBlobs,
  cleanupUploads
}
