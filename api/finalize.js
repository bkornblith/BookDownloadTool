const fs = require('fs')
const os = require('os')
const path = require('path')
const FileType = require('file-type')
const sanitize = require('sanitize-filename')
const { getKey, getUpload, readChunks, deleteFile, cleanupSometimes, normalizeKey } = require('../lib/store')
const { TYPE_EPUB, allowedTypes, allowedExtensions, extensionOf } = require('../lib/files')
const { deliver } = require('../lib/deliver')
const { isLoggedIn } = require('../lib/auth')
const library = require('../lib/library')

function flash (res, data) {
  console.log(data)
  res.status(data.success ? 200 : 400).send(data.message)
}

async function download (id, file) {
  const fd = fs.openSync(file, 'w')
  try {
    await readChunks(id, (data) => { fs.writeSync(fd, data) })
  } finally {
    fs.closeSync(fd)
  }
}

// Called by the upload page once all chunks of the book are uploaded. Checks the file,
// converts it with kepubify or KindleGen if asked, and hands it to the e-reader's key.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed')
    return
  }
  const body = req.body || {}
  const key = normalizeKey(body.key)
  const upload = await getUpload(body.id)

  if (!upload) {
    flash(res, { message: 'No file selected', success: false })
    return
  }
  const uploadId = upload.id
  if (upload.key !== key || upload.ready) {
    flash(res, { message: 'Invalid upload', success: false })
    return
  }

  const info = await getKey(key)
  if (!info) {
    await deleteFile(uploadId)
    flash(res, { message: 'Unknown key ' + key, success: false })
    return
  }

  let filename = ''

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-'))
  try {
    filename = sanitize(String(body.filename || ''))
    const ext = extensionOf(filename)
    if (!allowedExtensions.includes(ext)) {
      await deleteFile(uploadId)
      flash(res, { message: 'Invalid filetype: ' + filename, success: false })
      return
    }

    const infile = path.join(workdir, 'infile.' + ext)
    await download(uploadId, infile)

    if (fs.statSync(infile).size === 0) {
      await deleteFile(uploadId)
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
      await deleteFile(uploadId)
      flash(res, {
        message: 'Uploaded file is of an invalid type: ' + filename + ' (' + (type ? type.mime : 'unknown mimetype') + ')',
        success: false
      })
      return
    }

    // Logged in: keep a copy so the next Calibre sync adds it to the library
    let saved = false
    if (await isLoggedIn(req)) {
      try {
        await library.addToInbox(infile, filename)
        saved = true
      } catch (err) {
        console.error('Could not save to the library inbox', err)
      }
    }

    const result = await deliver({
      key,
      agent: info.agent,
      workdir,
      infile,
      filename,
      contentType: mimetype,
      convert: { kepubify: !!body.kepubify, kindlegen: !!body.kindlegen },
      storedId: uploadId
    })
    if (result.id !== uploadId) await deleteFile(uploadId)
    if (!result.success) {
      flash(res, result)
      return
    }
    flash(res, { success: true, message: 'Upload successful! ' + result.message + (saved ? '<br/>It will be added to your Calibre library on the next sync.' : '') })
  } catch (err) {
    await deleteFile(uploadId)
    throw err
  } finally {
    await cleanupSometimes()
    fs.rmSync(workdir, { recursive: true, force: true })
  }
}
