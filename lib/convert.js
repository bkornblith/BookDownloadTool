const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

// bin/kepubify and bin/kindlegen are downloaded by scripts/vercel-build.js and
// bundled into the finalize function (see includeFiles in vercel.json). The
// deployment is read-only and may not keep the executable bit, so run copies
// from /tmp.
function binary (name) {
  const override = process.env[name.toUpperCase() + '_PATH']
  if (override) return override
  const runnable = path.join(os.tmpdir(), name)
  if (!fs.existsSync(runnable)) {
    fs.copyFileSync(path.join(__dirname, '..', 'bin', name), runnable)
    fs.chmodSync(runnable, 0o755)
  }
  return runnable
}

function run (name, args, cwd, okCodes) {
  return new Promise((resolve, reject) => {
    let output = ''
    let proc
    try {
      proc = spawn(binary(name), args, { cwd })
    } catch (err) {
      reject(name + ' error: ' + err)
      return
    }
    proc.once('error', (err) => reject(name + ' error: ' + err))
    proc.stdout.on('data', (str) => { output += str })
    proc.stderr.on('data', (str) => { output += str })
    proc.once('close', (code) => {
      console.log(name + ': ' + output)
      if (!okCodes.includes(code)) {
        reject(name + ' error code: ' + code + '\n' + output)
        return
      }
      resolve()
    })
  })
}

// EPUB to Kobo EPUB
function kepubify (infile, outfile) {
  return run('kepubify', ['-v', '-u', '-o', path.basename(outfile), path.basename(infile)], path.dirname(infile), [0])
}

// EPUB to MOBI for Kindle. Exit code 1 means it finished with warnings.
function kindlegen (infile, outfile) {
  return run('kindlegen', [path.basename(infile), '-dont_append_source', '-c1', '-o', path.basename(outfile)], path.dirname(infile), [0, 1])
}

module.exports = { kepubify, kindlegen }
