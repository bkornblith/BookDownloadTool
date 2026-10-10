#!/usr/bin/env node
// Build step for Vercel: fetches the kepubify and KindleGen binaries that
// api/finalize.js bundles, and bundles the Vercel Blob upload client for the upload page.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const kepubifyUrl = 'https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit'
const kepubifySha256 = '37d7628d26c5c906f607f24b36f781f306075e7073a6fe7820a751bb60431fc5'

// KindleGen 2.9 for Linux, which Amazon no longer hosts
const kindlegenUrl = 'https://github.com/zzet/fp-docker/raw/f2b41fb0af6bb903afd0e429d5487acc62cb9df8/kindlegen_linux_2.6_i386_v2_9.tar.gz'
const kindlegenSha256 = '9828db5a2c8970d487ada2caa91a3b6403210d5d183a7e3849b1b206ff042296'

async function download (url, sha256) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Downloading ' + url + ' failed: HTTP ' + response.status)
  const data = Buffer.from(await response.arrayBuffer())
  const hash = crypto.createHash('sha256').update(data).digest('hex')
  if (hash !== sha256) throw new Error('Checksum mismatch for ' + url + ': ' + hash)
  return data
}

async function fetchKepubify () {
  const target = path.join(root, 'bin', 'kepubify')
  if (fs.existsSync(target)) return
  const data = await download(kepubifyUrl, kepubifySha256)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data, { mode: 0o755 })
  console.log('Downloaded kepubify to', target)
}

async function fetchKindlegen () {
  const target = path.join(root, 'bin', 'kindlegen')
  if (fs.existsSync(target)) return
  const data = await download(kindlegenUrl, kindlegenSha256)
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kindlegen-'))
  fs.writeFileSync(path.join(tmp, 'kindlegen.tar.gz'), data)
  execFileSync('tar', ['xzf', 'kindlegen.tar.gz', 'kindlegen'], { cwd: tmp })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(tmp, 'kindlegen'), target)
  fs.chmodSync(target, 0o755)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('Downloaded kindlegen to', target)
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

Promise.all([fetchKepubify(), fetchKindlegen(), bundleClient()]).catch((err) => {
  console.error(err)
  process.exit(1)
})
