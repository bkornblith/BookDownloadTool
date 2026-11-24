const { isLoggedIn, setSession } = require('../../lib/auth')
const passkeys = require('../../lib/passkeys')

// POST {action: 'loginOptions'}            options for navigator.credentials.get
// POST {action: 'login', response}         logs in with a passkey
// POST {action: 'registerOptions'}         options for navigator.credentials.create (logged in)
// POST {action: 'register', response}      saves a new passkey (logged in)
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const body = req.body || {}
  try {
    if (body.action === 'loginOptions') {
      res.json(await passkeys.loginOptions(req))
    } else if (body.action === 'login') {
      if (await passkeys.login(req, body.response)) {
        await setSession(res)
        res.json({ ok: true })
      } else {
        res.status(401).json({ error: "That passkey isn't recognised" })
      }
    } else if (body.action === 'registerOptions' || body.action === 'register') {
      if (!await isLoggedIn(req)) {
        res.status(401).json({ error: 'Not logged in' })
      } else if (body.action === 'registerOptions') {
        res.json(await passkeys.registrationOptions(req))
      } else if (await passkeys.register(req, body.response)) {
        res.json({ ok: true })
      } else {
        res.status(400).json({ error: 'Could not save the passkey' })
      }
    } else {
      res.status(400).json({ error: 'Unknown action' })
    }
  } catch (err) {
    console.error('Passkey error', err)
    res.status(400).json({ error: err.message })
  }
}
