const { createKey, getKey, removeKey, cleanup } = require('../lib/store')

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed')
    return
  }
  const agent = req.headers['user-agent'] || ''
  // The e-reader passes its previous key so that key stops working right away
  if (req.query.old) {
    try {
      const old = await getKey(req.query.old)
      if (old && old.agent === agent) await removeKey(req.query.old)
    } catch (err) {
      console.error('Could not remove old key', err)
    }
  }
  try {
    const removed = await cleanup()
    if (removed) console.log('Removed', removed, 'old file(s)')
  } catch (err) {
    console.error('Cleanup failed', err)
  }
  const key = await createKey(agent)
  if (!key) {
    console.error('Could not generate a unique key')
    res.send('error')
    return
  }
  console.log('Generated key', key, agent)
  res.setHeader('Cache-Control', 'no-store')
  res.send(key)
}
