// The library is for one person, with one passcode. It's chosen on the
// library page the first time it opens, and stored as a scrypt hash in
// Postgres (library_settings). Logging in sets a signed cookie that lasts 30
// days. Changing the passcode logs out every browser. The sync script uses a
// separate sync key (below).
const crypto = require('crypto')
const { query } = require('./store')

const cookieName = 'library'
const sessionAge = 30 * 24 * 60 * 60 * 1000
const maxFailures = 10  // wrong passcodes allowed per 15 minutes, in total
const failureWindow = 15 * 60 * 1000

function validPasscode (passcode) {
  return /^\d{6,12}$/.test(String(passcode || ''))
}

// Returns the stored hash ("salt:hash"), or null before one is set
async function storedHash () {
  const result = await query(`SELECT value FROM library_settings WHERE name = 'passcode'`)
  return result.rows[0] ? result.rows[0].value : null
}

function hashPasscode (passcode, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex')
  return salt + ':' + crypto.scryptSync(String(passcode), salt, 32).toString('hex')
}

function matches (passcode, stored) {
  const salt = stored.split(':')[0]
  const a = Buffer.from(hashPasscode(passcode, salt))
  const b = Buffer.from(stored)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function hmac (stored, text) {
  return crypto.createHmac('sha256', 'library-session:' + stored).update(text).digest('base64url')
}

function sameText (a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function cookies (req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

async function validSession (req) {
  const [expires, signature] = String(cookies(req)[cookieName] || '').split('.')
  if (!expires || !signature || !(Number(expires) > Date.now())) return false
  const stored = await storedHash()
  return !!stored && sameText(signature, hmac(stored, expires))
}

async function tooManyFailures () {
  const result = await query(
    `SELECT count(*) AS n FROM login_failures WHERE at > now() - $1 * interval '1 millisecond'`,
    [failureWindow])
  return Number(result.rows[0].n) >= maxFailures
}

async function recordFailure () {
  await query(`DELETE FROM login_failures WHERE at < now() - $1 * interval '1 millisecond'`, [failureWindow])
  await query('INSERT INTO login_failures DEFAULT VALUES')
}

// Once a passkey exists, the passcode no longer logs in: Touch ID / Face ID
// only. Setting LIBRARY_ALLOW_PASSCODE=1 on Vercel turns it back on, to
// recover after losing every passkey.
async function passcodeLoginAllowed () {
  if (process.env.LIBRARY_ALLOW_PASSCODE === '1') return true
  const result = await query('SELECT 1 FROM passkeys LIMIT 1')
  return result.rowCount === 0
}

// Checks a passcode. Returns 'ok', 'wrong', 'locked', 'unset' or 'off'.
async function checkPasscode (given) {
  const stored = await storedHash()
  if (!stored) return 'unset'
  if (!await passcodeLoginAllowed()) return 'off'
  if (await tooManyFailures()) return 'locked'
  if (given && matches(given, stored)) return 'ok'
  await recordFailure()
  return 'wrong'
}

// Sets the passcode. Only allowed when none is set yet; changing it needs a
// logged-in session (checked by the caller).
async function setPasscode (passcode, { replace } = {}) {
  const value = hashPasscode(passcode)
  const result = await query(
    `INSERT INTO library_settings (name, value) VALUES ('passcode', $1)
     ON CONFLICT (name) DO UPDATE SET value = $1 WHERE $2`,
    [value, !!replace])
  return result.rowCount === 1
}

async function setSession (res) {
  const stored = await storedHash()
  const expires = String(Date.now() + sessionAge)
  const secure = process.env.VERCEL ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${cookieName}=${expires}.${hmac(stored, expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionAge / 1000}${secure}`)
}

function clearSession (res) {
  res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

async function isLoggedIn (req) {
  try {
    return await validSession(req)
  } catch (err) {
    return false
  }
}

// The Mac sync authenticates with its own long random key (256 bits), not the
// passcode. Only its SHA-256 is stored; creating a new one revokes the old.
function sha256 (text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

async function createSyncKey () {
  const key = 'bdt_' + crypto.randomBytes(32).toString('base64url')
  await query(
    `INSERT INTO library_settings (name, value) VALUES ('sync_key', $1)
     ON CONFLICT (name) DO UPDATE SET value = $1`, [sha256(key)])
  return key
}

async function hasSyncKey () {
  const result = await query(`SELECT 1 FROM library_settings WHERE name = 'sync_key'`)
  return result.rowCount === 1
}

async function validSyncKey (given) {
  const result = await query(`SELECT value FROM library_settings WHERE name = 'sync_key'`)
  if (!result.rows[0] || !/^bdt_[A-Za-z0-9_-]{43}$/.test(given)) return false
  return sameText(sha256(given), result.rows[0].value)
}

// Lets a request through if it has a valid cookie or the sync key as a bearer
// token. Otherwise answers 401 (or 429 when locked out) and returns false.
async function requireAuth (req, res) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (await validSession(req)) return true
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (bearer) {
      if (await validSyncKey(bearer[1])) return true
      res.status(401).json({ error: 'Wrong sync key. Create a new one on the library page and run the installer again.' })
      return false
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
    return false
  }
  res.status(401).json({ error: 'Not logged in' })
  return false
}

module.exports = { passcodeLoginAllowed, createSyncKey, hasSyncKey, validPasscode, storedHash, checkPasscode, setPasscode, setSession, clearSession, requireAuth, isLoggedIn }
