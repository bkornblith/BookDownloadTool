const { getKey, normalizeKey, createUpload, addChunk, getUpload } = require('../lib/store')
const { maxFileSize, chunkSize } = require('../lib/files')

// Function request bodies are capped at 4.5 MB, so the upload page sends a
// book in chunks:
//   POST /api/upload  { key }            starts an upload, returns { id }
//   PUT  /api/upload?id=<id>&seq=<n>     raw bytes of chunk n, returns { size }
// and then calls /api/finalize with the id.
function readBody (req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (part) => {
      size += part.length
      if (size > limit) {
        reject(new Error('Chunk too large'))
        req.resume()
        return
      }
      parts.push(part)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method === 'POST') {
      const key = normalizeKey((req.body || {}).key)
      if (!(await getKey(key))) {
        res.status(400).json({ error: 'Unknown key ' + key })
        return
      }
      res.json({ id: await createUpload(key) })
    } else if (req.method === 'PUT') {
      const seq = Number(req.query.seq)
      const upload = await getUpload(req.query.id)
      if (!upload || upload.ready || !Number.isInteger(seq) || seq < 0 || seq * chunkSize >= maxFileSize) {
        res.status(400).json({ error: 'Invalid upload' })
        return
      }
      const data = await readBody(req, chunkSize)
      const size = await addChunk(upload.id, seq, data, maxFileSize)
      if (size === null) {
        res.status(400).json({ error: 'File is too large (50 MB at most)' })
        return
      }
      res.json({ size })
    } else {
      res.status(405).send('Method not allowed')
    }
  } catch (err) {
    console.error(err)
    res.status(400).json({ error: err.message })
  }
}
