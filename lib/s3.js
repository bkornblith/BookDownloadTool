// The Calibre library's books live in an S3-compatible bucket (Cloudflare R2,
// or Backblaze B2), since Neon's free 0.5 GB can't hold a whole library.
//
//   S3_ENDPOINT           e.g. https://<account id>.r2.cloudflarestorage.com
//   S3_BUCKET             bucket name
//   S3_ACCESS_KEY_ID      API token's access key
//   S3_SECRET_ACCESS_KEY  API token's secret
//   S3_REGION             optional, "auto" for R2 (the default)
const { AwsClient } = require('aws4fetch')

let client = null

function config () {
  const env = process.env
  const endpoint = (env.S3_ENDPOINT || '').replace(/\/+$/, '')
  if (!endpoint || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error('Library storage is not set up. Add the S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY environment variables.')
  }
  if (!client) {
    client = new AwsClient({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      service: 's3',
      region: env.S3_REGION || 'auto'
    })
  }
  return { endpoint, bucket: env.S3_BUCKET }
}

function aws () {
  config()
  return client
}

function objectUrl (name) {
  const { endpoint, bucket } = config()
  return endpoint + '/' + encodeURIComponent(bucket) + '/' + name.split('/').map(encodeURIComponent).join('/')
}

// A URL the sync script can PUT a book to (or GET one from) directly, so
// books never pass through a Vercel function (which takes at most 4.5 MB per
// request).
async function signedUrl (name, method, expiresSeconds = 6 * 60 * 60) {
  const url = new URL(objectUrl(name))
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds))
  const signed = await aws().sign(url.toString(), { method, aws: { signQuery: true } })
  return signed.url
}

const uploadUrl = (name) => signedUrl(name, 'PUT')
const downloadUrl = (name) => signedUrl(name, 'GET')

async function put (name, data) {
  const res = await aws().fetch(objectUrl(name), { method: 'PUT', body: data })
  if (!res.ok) throw new Error('Storage error ' + res.status + ' writing ' + name)
}

// Returns the object's size in bytes, or null if it doesn't exist
async function size (name) {
  const res = await aws().fetch(objectUrl(name), { method: 'HEAD' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Storage error ' + res.status + ' checking ' + name)
  return Number(res.headers.get('content-length'))
}

// Returns a fetch Response whose body streams the object
async function get (name) {
  const res = await aws().fetch(objectUrl(name))
  if (!res.ok) throw new Error('Storage error ' + res.status + ' reading ' + name)
  return res
}

async function remove (name) {
  const res = await aws().fetch(objectUrl(name), { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error('Storage error ' + res.status + ' deleting ' + name)
}

module.exports = { uploadUrl, downloadUrl, put, size, get, remove }
