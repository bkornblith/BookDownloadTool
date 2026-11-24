// The Calibre library: one row per book in Postgres (library_books), and one
// file per book in the S3 bucket at books/<calibre id>.<ext>.
//
// The sync script on Ben's computer sends the whole catalogue to plan(),
// uploads each new or changed book straight to the bucket, then calls
// commit() for it. Books no longer in Calibre are removed by plan().
const crypto = require('crypto')
const fs = require('fs')
const sanitize = require('sanitize-filename')
const { query } = require('./store')
const s3 = require('./s3')

// Calibre format -> file extension. The sync script sends one format per
// book, picked in this order.
const formats = {
  EPUB: 'epub',
  KEPUB: 'kepub.epub',
  AZW3: 'azw3',
  MOBI: 'mobi',
  AZW: 'azw',
  PDF: 'pdf',
  CBZ: 'cbz',
  CBR: 'cbr',
  TXT: 'txt'
}

const maxBookSize = 1024 * 1024 * 500

function cleanText (value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
}

// Checks and tidies one book from the sync script. Returns null if invalid.
function parseBook (input) {
  if (!input || typeof input !== 'object') return null
  const id = Number(input.id)
  const format = String(input.format || '').toUpperCase()
  const size = Number(input.size)
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return null
  if (!formats[format]) return null
  if (!Number.isInteger(size) || size <= 0 || size > maxBookSize) return null
  const fingerprint = cleanText(input.fingerprint, 200)
  if (!fingerprint) return null
  const title = cleanText(input.title, 500) || 'Unknown'
  const authors = cleanText(input.authors, 500)
  const ext = formats[format]
  const base = sanitize(authors ? title + ' - ' + authors : title).slice(0, 150).trim() || 'book' + id
  const seriesIndex = input.seriesIndex == null ? NaN : Number(input.seriesIndex)
  return {
    id,
    title,
    authors,
    sortAuthor: cleanText(input.sortAuthor, 500),
    series: cleanText(input.series, 500),
    seriesIndex: Number.isFinite(seriesIndex) ? seriesIndex : null,
    format,
    filename: base + '.' + ext,
    object: 'books/' + id + '.' + ext,
    size,
    fingerprint
  }
}

async function list () {
  const result = await query(
    `SELECT id, title, authors, series, series_index, format, size, added FROM library_books
     ORDER BY lower(sort_author), lower(series), series_index, lower(title)`)
  return result.rows.map((r) => ({
    id: r.id,
    title: r.title,
    authors: r.authors,
    series: r.series,
    seriesIndex: r.series_index,
    format: r.format,
    size: Number(r.size),
    added: r.added
  }))
}

async function get (id) {
  const result = await query('SELECT * FROM library_books WHERE id = $1', [Number(id) || 0])
  return result.rows[0] || null
}

async function saveRow (book) {
  await query(
    `INSERT INTO library_books (id, title, authors, sort_author, series, series_index, format, filename, object, size, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET title = $2, authors = $3, sort_author = $4, series = $5, series_index = $6,
       format = $7, filename = $8, object = $9, size = $10, fingerprint = $11`,
    [book.id, book.title, book.authors, book.sortAuthor, book.series, book.seriesIndex,
      book.format, book.filename, book.object, book.size, book.fingerprint])
}

async function removeRow (row) {
  await s3.remove(row.object)
  await query('DELETE FROM library_books WHERE id = $1', [row.id])
}

// Takes the whole catalogue. Updates titles and authors of unchanged books,
// removes books that are gone from Calibre, and returns upload URLs for books
// that are new or whose file changed.
async function plan (inputBooks) {
  const books = []
  const invalid = []
  for (const input of inputBooks) {
    const book = parseBook(input)
    if (book) books.push(book)
    else invalid.push(input && input.id)
  }
  const existing = new Map((await query('SELECT * FROM library_books')).rows.map((r) => [r.id, r]))
  const wanted = new Set(books.map((b) => b.id))

  let removed = 0
  for (const row of existing.values()) {
    if (!wanted.has(row.id)) {
      await removeRow(row)
      removed++
    }
  }

  const uploads = []
  let unchanged = 0
  for (const book of books) {
    const row = existing.get(book.id)
    if (row && row.fingerprint === book.fingerprint && row.object === book.object) {
      if (row.title !== book.title || row.authors !== book.authors || row.sort_author !== book.sortAuthor ||
          row.series !== book.series || row.series_index !== book.seriesIndex || row.filename !== book.filename) {
        await saveRow(book)
      }
      unchanged++
    } else {
      uploads.push({ id: book.id, url: await s3.uploadUrl(book.object) })
    }
  }
  return { uploads, removed, unchanged, invalid, inbox: await inbox() }
}

// Books sent from the upload page while logged in wait here until the sync
// script adds them to Calibre (which skips ones it already has).
async function addToInbox (file, filename) {
  const id = crypto.randomBytes(16).toString('hex')
  const object = 'inbox/' + id + '/' + filename
  const size = fs.statSync(file).size
  await s3.put(object, fs.readFileSync(file))
  await query('INSERT INTO library_inbox (id, filename, object, size) VALUES ($1, $2, $3, $4)', [id, filename, object, size])
}

async function inbox () {
  const result = await query('SELECT id, filename, object, size FROM library_inbox ORDER BY created')
  const items = []
  for (const row of result.rows) {
    items.push({ id: row.id, filename: row.filename, size: Number(row.size), url: await s3.downloadUrl(row.object) })
  }
  return items
}

async function inboxDone (id) {
  const result = await query('SELECT object FROM library_inbox WHERE id = $1', [String(id || '')])
  if (!result.rows[0]) return
  await s3.remove(result.rows[0].object)
  await query('DELETE FROM library_inbox WHERE id = $1', [String(id)])
}

// Records a book once the sync script has uploaded its file
async function commit (input) {
  const book = parseBook(input)
  if (!book) return { error: 'Invalid book' }
  const stored = await s3.size(book.object)
  if (stored !== book.size) {
    return { error: stored === null ? 'File not uploaded' : 'Uploaded file is ' + stored + ' bytes, expected ' + book.size }
  }
  const old = await get(book.id)
  await saveRow(book)
  if (old && old.object !== book.object) await s3.remove(old.object)
  return { ok: true }
}

module.exports = { formats, list, get, plan, commit, addToInbox, inbox, inboxDone }
