const fs = require('fs')
const os = require('os')
const path = require('path')
const FileType = require('file-type')
const sanitize = require('sanitize-filename')
const { getKey, getUpload, readChunks, writeFile, setReady, deleteFile, cleanupSometimes, normalizeKey } = require('../lib/store')
const { TYPE_EPUB, TYPE_MOBI, allowedTypes, allowedExtensions, contentTypes, chunkSize, extensionOf } = require('../lib/files')
const { kepubify, kindlegen } = require('../lib/convert')

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

  let conversion = null
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

    if (info.agent.includes('Kindle')) {
      filename = filename.replace(/[^\.\w\-"'\(\)]/g, '_')
    }

    let id = uploadId
    let size = fs.statSync(infile).size
    let contentType

    if (mimetype === TYPE_EPUB && info.agent.includes('Kindle') && body.kindlegen) {
      conversion = 'kindlegen'
      const outfile = path.join(workdir, 'outfile.mobi')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi')
      try {
        await kindlegen(infile, outfile)
      } catch (err) {
        await deleteFile(uploadId)
        flash(res, { success: false, message: String(err).replaceAll(workdir + '/', '') })
        return
      }
      id = await writeFile(key, fs.createReadStream(outfile, { highWaterMark: 1024 * 1024 }), chunkSize)
      size = fs.statSync(outfile).size
      contentType = TYPE_MOBI
      await deleteFile(uploadId)
    } else if (mimetype === TYPE_EPUB && info.agent.includes('Kobo') && body.kepubify) {
      conversion = 'kepubify'
      const outfile = path.join(workdir, 'outfile.kepub.epub')
      filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub')
      try {
        await kepubify(infile, outfile)
      } catch (err) {
        await deleteFile(uploadId)
        flash(res, { success: false, message: String(err).replaceAll(workdir + '/', '') })
        return
      }
      id = await writeFile(key, fs.createReadStream(outfile, { highWaterMark: 1024 * 1024 }), chunkSize)
      size = fs.statSync(outfile).size
      contentType = TYPE_EPUB
      await deleteFile(uploadId)
    } else {
      filename = filename.replace(/\.epub$/i, '.epub').replace(/\.pdf$/i, '.pdf')
      contentType = contentTypes[extensionOf(filename)] || mimetype
    }
    await setReady(key, id, { name: filename, contentType, size })
  } catch (err) {
    await deleteFile(uploadId)
    throw err
  } finally {
    await cleanupSometimes()
    fs.rmSync(workdir, { recursive: true, force: true })
  }

  const device = info.agent.includes('Kobo') ? 'a Kobo device.' : (info.agent.includes('Kindle') ? 'a Kindle device.' : 'a device.')
  flash(res, {
    message: 'Upload successful! ' + (conversion ? 'Ebook was converted with ' + conversion + ' and sent' : 'Sent') + ' to ' + device + '<br/>Filename: ' + filename,
    success: true
  })
}
