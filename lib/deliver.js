const fs = require('fs')
const path = require('path')
const { writeFile, setReady, deleteFile } = require('./store')
const { TYPE_EPUB, TYPE_MOBI, contentTypes, chunkSize, extensionOf } = require('./files')
const { kepubify, kindlegen } = require('./convert')

function deviceName (agent) {
  return agent.includes('Kobo') ? 'a Kobo device.' : (agent.includes('Kindle') ? 'a Kindle device.' : 'a device.')
}

function escapeHtml (text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// Converts a book in workdir if asked (kepubify for Kobo, KindleGen for
// Kindle), stores it, and makes it the book the key's e-reader is offered.
//
// storedId is the id of infile's copy already in the database, if there is
// one; it's offered as is when no conversion is needed. Returns
// { success, message, id } where id is the stored file now offered.
async function deliver ({ key, agent, workdir, infile, filename, contentType, convert, storedId }) {
  let conversion = null
  let outfile = null

  if (agent.includes('Kindle')) {
    filename = filename.replace(/[^\.\w\-"'\(\)]/g, '_')
  }

  if (contentType === TYPE_EPUB && agent.includes('Kindle') && convert.kindlegen) {
    conversion = 'kindlegen'
    outfile = path.join(workdir, 'outfile.mobi')
    filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.mobi')
    try {
      await kindlegen(infile, outfile)
    } catch (err) {
      return { success: false, message: String(err).replaceAll(workdir + '/', '') }
    }
    contentType = TYPE_MOBI
  } else if (contentType === TYPE_EPUB && agent.includes('Kobo') && convert.kepubify) {
    conversion = 'kepubify'
    outfile = path.join(workdir, 'outfile.kepub.epub')
    filename = filename.replace(/\.kepub\.epub$/i, '.epub').replace(/\.epub$/i, '.kepub.epub')
    try {
      await kepubify(infile, outfile)
    } catch (err) {
      return { success: false, message: String(err).replaceAll(workdir + '/', '') }
    }
  } else {
    contentType = contentTypes[extensionOf(filename)] || contentType
  }

  const file = outfile || infile
  const size = fs.statSync(file).size
  let id = outfile ? null : storedId
  if (!id) {
    id = await writeFile(key, fs.createReadStream(file, { highWaterMark: 1024 * 1024 }), chunkSize)
  }
  try {
    await setReady(key, id, { name: filename, contentType, size })
  } catch (err) {
    if (id !== storedId) await deleteFile(id)
    throw err
  }

  return {
    success: true,
    id,
    message: (conversion ? 'Converted with ' + conversion + ' and sent' : 'Sent') + ' to ' + deviceName(agent) + '<br/>Filename: ' + escapeHtml(filename)
  }
}

module.exports = { deliver }
