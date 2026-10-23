const { getKey, getFile, normalizeKey } = require('../lib/store')

// The e-reader downloads /<filename>?key=<KEY>; send it on to the file in Blob storage.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const key = normalizeKey(req.query.key)
  const filename = req.query.filename
  const info = await getKey(key)
  const file = info && await getFile(key)
  if (!file || file.name !== filename) {
    res.status(404).send('Not found')
    return
  }
  if (info.agent !== (req.headers['user-agent'] || '')) {
    console.error('User Agent doesnt match: ' + info.agent + ' VS ' + req.headers['user-agent'])
    res.status(404).send('Not found')
    return
  }
  console.log('Sending file', file.name)
  // new URL() percent-encodes the filename if the stored URL isn't already
  const location = new URL(file.url)
  if (info.agent.includes('Kindle')) {
    // Kindle needs the file sent as an attachment or it thinks it's invalid
    location.searchParams.set('download', '1')
  }
  res.redirect(302, location.href)
}
