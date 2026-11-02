const { getKey, normalizeKey, readChunks, markDownloaded } = require('../lib/store')

// The e-reader downloads /<filename>?key=<KEY>; stream the book out of Postgres.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const key = normalizeKey(req.query.key)
  const filename = req.query.filename
  const info = await getKey(key)
  const file = info && info.file
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
  res.statusCode = 200
  res.setHeader('Content-Type', file.contentType)
  res.setHeader('Content-Length', String(file.size))
  if (info.agent.includes('Kindle')) {
    // Kindle needs the file sent as an attachment or it thinks it's invalid
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.name))
  }
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  try {
    await readChunks(file.id, (data) => new Promise((resolve, reject) => {
      if (res.destroyed) {
        reject(new Error('Download cancelled'))
        return
      }
      if (res.write(data)) resolve()
      else res.once('drain', resolve)
    }))
    res.end()
    // Deleted a few minutes from now, in case the e-reader asks again
    await markDownloaded(file.id)
  } catch (err) {
    console.error('Download failed', err)
    res.destroy(err)
  }
}
