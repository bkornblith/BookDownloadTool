const { createKey, cleanupBlobs } = require('../lib/store')

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed')
    return
  }
  const agent = req.headers['user-agent'] || ''
  const key = await createKey(agent)
  if (!key) {
    console.error('Could not generate a unique key')
    res.send('error')
    return
  }
  console.log('Generated key', key, agent)
  try {
    const removed = await cleanupBlobs()
    if (removed) console.log('Removed', removed, 'old file(s)')
  } catch (err) {
    console.error('Cleanup failed', err)
  }
  res.setHeader('Cache-Control', 'no-store')
  res.send(key)
}
