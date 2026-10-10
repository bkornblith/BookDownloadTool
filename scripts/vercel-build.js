#!/usr/bin/env node
// Build step for Vercel: fetches the kepubify binary that api/finalize.js
// bundles, and bundles the Vercel Blob upload client for the upload page.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const kepubifyUrl = 'https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit'
const kepubifySha256 = '37d7628d26c5c906f607f24b36f781f306075e7073a6fe7820a751bb60431fc5'

async function fetchKepubify () {
  const target = path.join(root, 'bin', 'kepubify')
  if (fs.existsSync(target)) {
    const existing = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
    if (existing === kepubifySha256) return
  }
  const response = await fetch(kepubifyUrl)
  if (!response.ok) throw new Error('Downloading kepubify failed: HTTP ' + response.status)
  const data = Buffer.from(await response.arrayBuffer())
  const hash = crypto.createHash('sha256').update(data).digest('hex')
  if (hash !== kepubifySha256) throw new Error('kepubify checksum mismatch: ' + hash)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data, { mode: 0o755 })
  console.log('Downloaded kepubify to', target)
}

async function bundleClient () {
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'upload-client.js')],
    outfile: path.join(root, 'public', 'upload-client.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2018']
  })
  console.log('Bundled public/upload-client.js')
}

Promise.all([fetchKepubify(), bundleClient()]).catch((err) => {
  console.error(err)
  process.exit(1)
})
