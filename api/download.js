const { getKey, touchKey, normalizeKey } = require('../lib/store')

// The e-reader downloads /<filename>?key=<KEY>; send it on to the file in Blob storage.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const key = normalizeKey(req.query.key)
  const filename = req.query.filename
  const info = await getKey(key)
  if (!info || !info.file || info.file.name !== filename) {
    res.status(404).send('Not found')
    return
  }
  if (info.agent !== (req.headers['user-agent'] || '')) {
    console.error('User Agent doesnt match: ' + info.agent + ' VS ' + req.headers['user-agent'])
    res.status(404).send('Not found')
    return
  }
  await touchKey(key)
  console.log('Sending file', info.file.name)
  // new URL() percent-encodes the filename if the stored URL isn't already
  res.redirect(302, new URL(info.file.url).href)
}
