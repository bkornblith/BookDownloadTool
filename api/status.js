const { getKey, normalizeKey, cleanupSometimes } = require('../lib/store')

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
  const file = info.file
  res.json({
    alive: new Date(),
    file: file ? { name: file.name } : null
  })
  // The e-reader polls this, so it doubles as the trigger for deleting books
  // a few minutes after they were downloaded.
  await cleanupSometimes()
}
