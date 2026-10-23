const { getKey, normalizeKey } = require('../lib/store')

// Tells the upload page which kind of e-reader a key belongs to, so it can
// switch on the matching conversion.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const info = await getKey(normalizeKey(req.query.key), { fresh: true })
  if (!info) {
    res.status(404).json({ error: 'Unknown key' })
    return
  }
  const agent = info.agent || ''
  const device = agent.includes('Kobo') ? 'kobo' : (agent.includes('Kindle') ? 'kindle' : 'other')
  res.json({ device })
}
