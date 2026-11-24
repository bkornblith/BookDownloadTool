// Passkeys (Touch ID / Face ID) for the library login. Adding one needs a
// logged-in session; the passcode stays as the fallback and for the sync
// script. Passkeys are bound to the site's hostname.
const crypto = require('crypto')
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server')
const { query } = require('./store')

const challengeAge = 5 * 60 * 1000

function site (req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  const rpID = host.replace(/:\d+$/, '')
  const local = rpID === 'localhost'
  return { rpID, origin: (local ? 'http://' : 'https://') + host }
}

async function saveChallenge (challenge) {
  await query(`DELETE FROM passkey_challenges WHERE created < now() - $1 * interval '1 millisecond'`, [challengeAge])
  await query('INSERT INTO passkey_challenges (challenge) VALUES ($1)', [challenge])
}

// Each challenge can be used once, within 5 minutes
async function useChallenge (challenge) {
  const result = await query(
    `DELETE FROM passkey_challenges WHERE challenge = $1 AND created > now() - $2 * interval '1 millisecond'`,
    [challenge, challengeAge])
  return result.rowCount === 1
}

async function list () {
  const result = await query('SELECT id, public_key, counter, transports FROM passkeys ORDER BY created')
  return result.rows.map((r) => ({
    id: r.id,
    publicKey: new Uint8Array(r.public_key),
    counter: Number(r.counter),
    transports: r.transports ? r.transports.split(',') : undefined
  }))
}

async function count () {
  const result = await query('SELECT count(*) AS n FROM passkeys')
  return Number(result.rows[0].n)
}

async function registrationOptions (req) {
  const { rpID } = site(req)
  const existing = await list()
  const options = await generateRegistrationOptions({
    rpName: 'Book library',
    rpID,
    userName: 'Book library',
    userID: crypto.createHash('sha256').update('library-owner').digest().subarray(0, 16),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
  })
  await saveChallenge(options.challenge)
  return options
}

async function register (req, response) {
  const { rpID, origin } = site(req)
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: useChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true
  })
  if (!result.verified) return false
  const { credential } = result.registrationInfo
  await query(
    `INSERT INTO passkeys (id, public_key, counter, transports) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [credential.id, Buffer.from(credential.publicKey), credential.counter, (credential.transports || []).join(',')])
  return true
}

async function loginOptions (req) {
  const { rpID } = site(req)
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' })
  await saveChallenge(options.challenge)
  return options
}

async function login (req, response) {
  const { rpID, origin } = site(req)
  const credential = (await list()).find((c) => c.id === (response && response.id))
  if (!credential) return false
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: useChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
    requireUserVerification: true
  })
  if (!result.verified) return false
  await query('UPDATE passkeys SET counter = $2, used = now() WHERE id = $1', [credential.id, result.authenticationInfo.newCounter])
  return true
}

module.exports = { count, registrationOptions, register, loginOptions, login }
