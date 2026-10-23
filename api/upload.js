const { handleUpload } = require('@vercel/blob/client')
const { getKey, normalizeKey } = require('../lib/store')
const { allowedExtensions, maxFileSize } = require('../lib/files')

// Hands the browser a short-lived token so it can upload the book straight to
// Vercel Blob. Function request bodies are capped at 4.5 MB, so the file
// itself never passes through here.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed')
    return
  }
  try {
    const result = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload = {}
        try {
          payload = JSON.parse(clientPayload || '{}')
        } catch (err) {}
        const key = normalizeKey(payload.key)
        if (!(await getKey(key, { fresh: true }))) {
          throw new Error('Unknown key ' + key)
        }
        const match = /^uploads\/([A-Z0-9]{4})\/upload\.([a-z]+)$/.exec(pathname)
        if (!match || match[1] !== key || !allowedExtensions.includes(match[2])) {
          throw new Error('Invalid file type')
        }
        return {
          addRandomSuffix: true,
          maximumSizeInBytes: maxFileSize,
          validUntil: Date.now() + 10 * 60 * 1000
        }
      }
    })
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}
