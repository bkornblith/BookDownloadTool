const { requireAuth } = require('../../lib/auth')
const library = require('../../lib/library')

// Used by scripts/calibre-sync.py, with the password as a bearer token.
//   POST {action: 'plan', books: [...]}  the whole catalogue; returns upload URLs
//   POST {action: 'commit', book: {...}}  after a book's file is uploaded
//   POST {action: 'inbox'}  books sent while logged in, to add to Calibre
//   POST {action: 'inboxDone', id}  once one is added to Calibre
module.exports = async (req, res) => {
  if (!await requireAuth(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const body = req.body || {}
  if (body.action === 'plan') {
    if (!Array.isArray(body.books) || body.books.length === 0) {
      // An empty list would delete the whole library, which is never intended
      res.status(400).json({ error: 'No books sent' })
      return
    }
    res.json(await library.plan(body.books))
  } else if (body.action === 'commit') {
    const result = await library.commit(body.book)
    res.status(result.error ? 400 : 200).json(result)
  } else if (body.action === 'inboxDone') {
    await library.inboxDone(body.id)
    res.json({ ok: true })
  } else if (body.action === 'inbox') {
    res.json({ inbox: await library.inbox() })
  } else {
    res.status(400).json({ error: 'Unknown action' })
  }
}
