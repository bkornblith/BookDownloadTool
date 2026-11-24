const { validPasscode, storedHash, checkPasscode, setPasscode, setSession, clearSession, isLoggedIn } = require('../../lib/auth')

// GET                          { loggedIn, passcodeSet }
// POST {passcode}              logs in
// POST {setup: passcode}       sets the first passcode (only while none is set)
// POST {current, change}       changes it (logged in, with the current passcode)
// POST {logout: true}          logs out
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method === 'GET') {
      res.json({ loggedIn: await isLoggedIn(req), passcodeSet: !!(await storedHash()) })
      return
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' })
      return
    }
    const body = req.body || {}
    if (body.logout) {
      clearSession(res)
      res.json({ ok: true })
      return
    }
    if (body.setup !== undefined || body.change !== undefined) {
      const passcode = String(body.setup !== undefined ? body.setup : body.change)
      if (!validPasscode(passcode)) {
        res.status(400).json({ error: 'Use 6 to 12 digits' })
        return
      }
      if (body.change !== undefined) {
        if (!await isLoggedIn(req) || await checkPasscode(String(body.current || '')) !== 'ok') {
          res.status(401).json({ error: 'Current passcode is wrong' })
          return
        }
      }
      if (!await setPasscode(passcode, { replace: body.change !== undefined })) {
        res.status(409).json({ error: 'A passcode is already set' })
        return
      }
      await setSession(res)
      res.json({ ok: true })
      return
    }
    const result = await checkPasscode(String(body.passcode || ''))
    if (result === 'ok') {
      await setSession(res)
      res.json({ ok: true })
    } else if (result === 'locked') {
      res.status(429).json({ error: 'Too many wrong passcodes. Try again in 15 minutes.' })
    } else if (result === 'unset') {
      res.status(409).json({ error: 'No passcode is set yet' })
    } else {
      res.status(401).json({ error: 'Wrong passcode' })
    }
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
}
