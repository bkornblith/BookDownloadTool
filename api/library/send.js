const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { requireAuth } = require('../../lib/auth')
const library = require('../../lib/library')
const s3 = require('../../lib/s3')
const { getKey, normalizeKey, cleanupSometimes } = require('../../lib/store')
const { TYPE_EPUB, contentTypes, extensionOf } = require('../../lib/files')
const { deliver } = require('../../lib/deliver')

const maxSendSize = 150 * 1024 * 1024

// POST {id, key}: sends a library book to the e-reader showing the key,
// converted for Kobo (kepubify) or Kindle (KindleGen) when it's an EPUB.
module.exports = async (req, res) => {
  if (!await requireAuth(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const body = req.body || {}
  const key = normalizeKey(body.key)
  const info = await getKey(key)
  if (!info) {
    res.status(400).json({ error: 'No e-reader is showing the key ' + key })
    return
  }
  const book = await library.get(body.id)
  if (!book) {
    res.status(404).json({ error: 'Book not found' })
    return
  }
  if (book.size > maxSendSize) {
    // The copy for the e-reader is kept in Neon, which has 0.5 GB in all
    res.status(400).json({ error: 'This book is too large to send (over 150 MB).' })
    return
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-'))
  try {
    const kepub = /\.kepub\.epub$/i.test(book.filename)
    const infile = path.join(workdir, 'infile.' + (kepub ? 'kepub.epub' : extensionOf(book.filename)))
    const stored = await s3.get(book.object)
    await pipeline(Readable.fromWeb(stored.body), fs.createWriteStream(infile))

    const result = await deliver({
      key,
      agent: info.agent,
      workdir,
      infile,
      filename: book.filename,
      contentType: kepub ? TYPE_EPUB : (contentTypes[extensionOf(book.filename)] || 'application/octet-stream'),
      convert: { kepubify: !kepub, kindlegen: true }
    })
    if (!result.success) {
      res.status(400).json({ error: result.message })
      return
    }
    const after = await getKey(key)
    res.json({ message: result.message, waiting: after ? after.files.filter((f) => !f.downloaded).length : 1 })
  } finally {
    await cleanupSometimes()
    fs.rmSync(workdir, { recursive: true, force: true })
  }
}
