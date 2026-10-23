const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const { put, rename } = require('@vercel/blob')
const FileType = require('file-type')
const sanitize = require('sanitize-filename')
const { getKey, getFile, setFile, deleteBlob, normalizeKey } = require('../lib/store')
const { TYPE_EPUB, TYPE_MOBI, allowedTypes, allowedExtensions, contentTypes, extensionOf } = require('../lib/files')
const { kepubify, kindlegen } = require('../lib/convert')

function flash (res, data) {
  console.log(data)
  res.status(data.success ? 200 : 400).send(data.message)
}

// Only accept files the browser just uploaded to our Blob store for this key
function isUploadForKey (blobUrl, key) {
  try {
    const url = new URL(blobUrl)
    return url.protocol === 'https:' &&
      url.hostname.endsWith('.blob.vercel-storage.com') &&
      url.pathname.startsWith('/uploads/' + key + '/')
  } catch (err) {
    return false
  }
}

async function download (url, file) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error('Could not read uploaded file: HTTP ' + response.status)
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file))
}

// Called by the upload page once the book is in Blob storage. Checks the file,
// converts it with kepubify or KindleGen if asked, and hands it to the e-reader's key.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed')
    return
  }
  const body = req.body || {}
  const key = normalizeKey(body.key)
  const blobUrl = body.blobUrl || null

  if (!blobUrl) {
    flash(res, { message: 'No file selected', success: false })
    return
  }
  if (!isUploadForKey(blobUrl, key)) {
    flash(res, { message: 'Invalid upload', success: false })
    return
  }

  const info = await getKey(key, { fresh: true })
  if (!info) {
    await deleteBlob(blobUrl)
    flash(res, { message: 'Unknown key ' + key, success: false })
    return
  }

  let conversion = null
  let filename = ''

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-'))
  try {
    filename = sanitize(String(body.filename || ''))
    const ext = extensionOf(filename)
    if (!allowedExtensions.includes(ext)) {
      await deleteBlob(blobUrl)
      flash(res, { message: 'Invalid filetype: ' + filename, success: false })
      return
    }

    const infile = path.join(workdir, 'infile.' + ext)
    await download(blobUrl, infile)

    if (fs.statSync(infile).size === 0) {
      await deleteBlob(blobUrl)
      flash(res, { message: 'Invalid file submitted (empty file)', success: false })
      return
    }

    let mimetype = body.mimetype || 'application/octet-stream'
    const type = await FileType.fromFile(infile)
    if ((mimetype === 'application/octet-stream' || mimetype === '') && type) {
      mimetype = type.mime
    }
    if (mimetype === 'application/epub') {
      mimetype = TYPE_EPUB
    }
    if ((!type || !allowedTypes.includes(type.mime)) && !allowedTypes.includes(mimetype)) {
      await deleteBlob(blobUrl)
      flash(res, {
        message: 'Uploaded file is of an invalid type: ' + filename + ' (' + (type ? type.mime : 'unknown mimetype') + ')',
        success: false
      })
      return
    }

    if (info.agent.includes('Kindle')) {
      filename = filename.replace(/[^\.\w\-"'\(\)]/g, '_')
    }

    // A random folder keeps the public Blob URL unguessable while the file
    // keeps its real name for the e-reader.
    const pathname = 'books/' + crypto.randomBytes(16).toString('hex') + '/'
    let blob

    if (mimetype === TYPE_EPUB && info.agent.includes('Kindle') && body.kindlegen) {
      conversion = 'kindlegen'
      const outfile = path.join(workdir, 'outfile.mobi')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi')
      try {
        await kindlegen(infile, outfile)
      } catch (err) {
        await deleteBlob(blobUrl)
        flash(res, { success: false, message: String(err).replaceAll(workdir + '/', '') })
        return
      }
      blob = await put(pathname + filename, fs.createReadStream(outfile), {
        access: 'public',
        addRandomSuffix: false,
        contentType: TYPE_MOBI,
        multipart: fs.statSync(outfile).size > 50 * 1024 * 1024
      })
      await deleteBlob(blobUrl)
    } else if (mimetype === TYPE_EPUB && info.agent.includes('Kobo') && body.kepubify) {
      conversion = 'kepubify'
      const outfile = path.join(workdir, 'outfile.kepub.epub')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub')
      try {
        await kepubify(infile, outfile)
      } catch (err) {
        await deleteBlob(blobUrl)
        flash(res, { success: false, message: String(err).replaceAll(workdir + '/', '') })
        return
      }
      blob = await put(pathname + filename, fs.createReadStream(outfile), {
        access: 'public',
        addRandomSuffix: false,
        contentType: TYPE_EPUB,
        multipart: fs.statSync(outfile).size > 50 * 1024 * 1024
      })
      await deleteBlob(blobUrl)
    } else {
      filename = filename.replace(/\.epub$/i, '.epub').replace(/\.pdf$/i, '.pdf')
      blob = await rename(blobUrl, pathname + filename, {
        access: 'public',
        addRandomSuffix: false,
        contentType: contentTypes[extensionOf(filename)] || mimetype
      })
    }
    const previous = await getFile(key)
    await setFile(key, { name: filename, url: blob.url })
    if (previous && previous.url !== blob.url) {
      await deleteBlob(previous.url)
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true })
  }

  const device = info.agent.includes('Kobo') ? 'a Kobo device.' : (info.agent.includes('Kindle') ? 'a Kindle device.' : 'a device.')
  flash(res, {
    message: 'Upload successful! ' + (conversion ? 'Ebook was converted with ' + conversion + ' and sent' : 'Sent') + ' to ' + device + '<br/>Filename: ' + filename,
    success: true
  })
}
