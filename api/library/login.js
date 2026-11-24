const { checkPassword, setSession, clearSession, isLoggedIn } = require('../../lib/auth')

// POST {password} logs in; POST {logout: true} logs out; GET says whether
// this browser is logged in.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'GET') {
    res.json({ loggedIn: isLoggedIn(req) })
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
  let result
  try {
    result = await checkPassword(String(body.password || ''))
  } catch (err) {
    res.status(500).json({ error: err.message })
    return
  }
  if (result === 'ok') {
    setSession(res)
    res.json({ ok: true })
  } else if (result === 'locked') {
    res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' })
  } else {
    res.status(401).json({ error: 'Wrong password' })
  }
}
