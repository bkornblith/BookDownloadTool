const { requireAuth } = require('../../lib/auth')
const library = require('../../lib/library')

// The library's catalogue, for the library page
module.exports = async (req, res) => {
  if (!await requireAuth(req, res)) return
  res.json({ books: await library.list() })
}
