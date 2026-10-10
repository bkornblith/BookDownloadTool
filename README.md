# send2ereader

A self hostable service for sending ebooks to a Kobo or Kindle ereader through the built-in browser.

## How To Run

### On Vercel

Files go straight from the browser to Vercel Blob and pairing keys live in Redis. EPUBs are converted with bundled copies of [Kepubify](https://github.com/pgaskin/kepubify) for Kobo and KindleGen (to MOBI) for Kindle. pdfCropMargins is not available here; other files are sent unprocessed.

1. Import this repository as a new project at https://vercel.com/new. Keep the default settings; `vercel.json` sets the build.
2. In the project's **Storage** tab, create a **Blob** store and connect it to the project. This sets `BLOB_READ_WRITE_TOKEN`.
3. In the same tab, add a **Redis** database (Upstash from the Marketplace, free plan) and connect it. This sets `REDIS_URL` (or `KV_URL`, which also works).
4. Redeploy so the new environment variables are picked up.
5. Open the deployment URL on the Kobo's browser to get a key, and on your phone or computer to upload.

Keys expire about a minute after the e-reader stops showing them, and uploaded files are deleted within an hour (on the next key generated, plus a daily cleanup cron).

### On Your Host OS

1. Have Node.js 16 or 20 installed
2. Install this service's dependencies by running `$ npm install`
3. Install [Kepubify](https://github.com/pgaskin/kepubify), and have the kepubify executable in your PATH.
4. Install [KindleGen](http://web.archive.org/web/*/http://kindlegen.s3.amazonaws.com/kindlegen*), and have the kindlegen executable in your PATH.
5. Install [pdfCropMargins](https://github.com/abarker/pdfCropMargins), and have the pdfcropmargins executable in your PATH.
6. Start this service by running: `$ npm start` and access it on HTTP port 3001

### Containerized
1. You need [Docker](https://www.docker.com/) and [docker-compose](https://docs.docker.com/compose/) installed
2. Clone this repo (you need Dockerfile, docker-compose.yaml and package.json in the same directory)
```
git clone https://github.com/daniel-j/send2ereader.git
```
3. Build the image
```
docker compose build
```
4. run container (-d to keep running in the background)
```
docker compose up -d
```
5. Access the service on HTTP, default port 3001 (http://localhost:3001)
