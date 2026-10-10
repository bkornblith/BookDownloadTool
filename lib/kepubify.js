const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

// bin/kepubify is downloaded by scripts/vercel-build.js and bundled into the
// function (see includeFiles in vercel.json). The deployment is read-only and
// may not keep the executable bit, so run a copy from /tmp.
const bundled = path.join(__dirname, '..', 'bin', 'kepubify')
const runnable = path.join(require('os').tmpdir(), 'kepubify')

function binary () {
  if (process.env.KEPUBIFY_PATH) return process.env.KEPUBIFY_PATH
  if (!fs.existsSync(runnable)) {
    fs.copyFileSync(bundled, runnable)
    fs.chmodSync(runnable, 0o755)
  }
  return runnable
}

function kepubify (infile, outfile) {
  return new Promise((resolve, reject) => {
    let output = ''
    let proc
    try {
      proc = spawn(binary(), ['-v', '-u', '-o', path.basename(outfile), path.basename(infile)], {
        cwd: path.dirname(infile)
      })
    } catch (err) {
      reject('kepubify error: ' + err)
      return
    }
    proc.once('error', (err) => reject('kepubify error: ' + err))
    proc.stdout.on('data', (str) => { output += str })
    proc.stderr.on('data', (str) => { output += str })
    proc.once('close', (code) => {
      console.log('kepubify: ' + output)
      if (code !== 0) {
        reject('Kepubify error code: ' + code + '\n' + output)
        return
      }
      resolve(outfile)
    })
  })
}

module.exports = kepubify
