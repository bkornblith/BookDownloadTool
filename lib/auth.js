// The library is for one person, with one password set in the
// LIBRARY_PASSWORD environment variable. Logging in sets a signed cookie that
// lasts 30 days; the sync script sends the password as a bearer token.
// Changing the password logs out every browser.
const crypto = require('crypto')
const { query } = require('./store')

const cookieName = 'library'
const sessionAge = 30 * 24 * 60 * 60 * 1000
const maxFailures = 10  // wrong passwords allowed per 15 minutes, in total
const failureWindow = 15 * 60 * 1000

function password () {
  const value = process.env.LIBRARY_PASSWORD || ''
  if (value.length < 8) throw new Error('Set LIBRARY_PASSWORD (at least 8 characters) to use the library.')
  return value
}

function hmac (text) {
  return crypto.createHmac('sha256', 'library-session:' + password()).update(text).digest('base64url')
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

function validSession (value) {
  const [expires, signature] = String(value || '').split('.')
  if (!expires || !signature || !(Number(expires) > Date.now())) return false
  return sameText(signature, hmac(expires))
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

// Checks a password. Returns 'ok', 'wrong' or 'locked'.
async function checkPassword (given) {
  password()
  if (await tooManyFailures()) return 'locked'
  if (given && sameText(given, password())) return 'ok'
  await recordFailure()
  return 'wrong'
}

function setSession (res) {
  const expires = String(Date.now() + sessionAge)
  const secure = process.env.VERCEL ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${cookieName}=${expires}.${hmac(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionAge / 1000}${secure}`)
}

function clearSession (res) {
  res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function isLoggedIn (req) {
  try {
    return validSession(cookies(req)[cookieName])
  } catch (err) {
    return false  // no password set
  }
}

// Lets a request through if it has a valid cookie or the password as a bearer
// token. Otherwise answers 401 (or 429 when locked out) and returns false.
async function requireAuth (req, res) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (validSession(cookies(req)[cookieName])) return true
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (bearer) {
      const result = await checkPassword(bearer[1])
      if (result === 'ok') return true
      res.status(result === 'locked' ? 429 : 401).json({ error: result === 'locked' ? 'Too many wrong passwords. Try again in 15 minutes.' : 'Wrong password' })
      return false
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
    return false
  }
  res.status(401).json({ error: 'Not logged in' })
  return false
}

module.exports = { checkPassword, setSession, clearSession, requireAuth, isLoggedIn }
