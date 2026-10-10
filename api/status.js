const { getKey, touchKey, normalizeKey } = require('../lib/store')

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const key = normalizeKey(req.query.key)
  const info = await getKey(key)
  if (!info) {
    res.status(404).json({ error: 'Unknown key' })
    return
  }
  if (info.agent !== (req.headers['user-agent'] || '')) {
    // don't send this error to client
    console.error('User Agent doesnt match: ' + info.agent + ' VS ' + req.headers['user-agent'])
    res.status(204).end()
    return
  }
  await touchKey(key)
  res.json({
    alive: new Date(),
    file: info.file ? { name: info.file.name } : null,
    urls: info.urls
  })
}
