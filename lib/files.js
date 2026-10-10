const TYPE_EPUB = 'application/epub+zip'
const TYPE_MOBI = 'application/x-mobipocket-ebook'

const allowedTypes = [TYPE_EPUB, TYPE_MOBI, 'application/pdf', 'application/vnd.comicbook+zip', 'application/vnd.comicbook-rar', 'text/html', 'text/plain', 'application/zip', 'application/x-rar-compressed']
const allowedExtensions = ['epub', 'mobi', 'pdf', 'cbz', 'cbr', 'html', 'txt']

const contentTypes = {
  epub: TYPE_EPUB,
  mobi: TYPE_MOBI,
  pdf: 'application/pdf',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  html: 'text/html',
  txt: 'text/plain'
}

const maxFileSize = 1024 * 1024 * 200  // 200 MB, enough room left in /tmp to convert

function extensionOf (filename) {
  const match = /\.([^.]+)$/.exec(filename || '')
  return match ? match[1].toLowerCase() : ''
}

module.exports = {
  TYPE_EPUB,
  TYPE_MOBI,
  allowedTypes,
  allowedExtensions,
  contentTypes,
  maxFileSize,
  extensionOf
}
