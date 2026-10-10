# Book Download Tool

Send ebooks to a Kobo or Kindle e-reader through its built-in browser, hosted on Vercel. Based on [send2ereader](https://github.com/daniel-j/send2ereader).

Open the site on the e-reader to get a 4-character key, then open it on a phone or computer, enter the key and pick a book. The e-reader shows a download link for it.

Files go straight from the browser to Vercel Blob and pairing keys live in Redis. EPUBs are converted with bundled copies of [Kepubify](https://github.com/pgaskin/kepubify) for Kobo and KindleGen (to MOBI) for Kindle. The upload page detects which e-reader is showing the key and turns on the matching conversion; if it can't tell, it shows both options. Other files are sent unprocessed.

## Deploy

1. Import this repository as a new project at https://vercel.com/new. Keep the default settings; `vercel.json` sets the build.
2. In the project's **Storage** tab, create a **Blob** store with public access and connect it to the project. Any environment variable prefix works.
3. In the same tab, add a **Redis** database (Upstash from the Marketplace) and connect it. Any environment variable prefix works.
4. Redeploy so the new environment variables are picked up.

Keys expire about a minute after the e-reader stops showing them, and uploaded files are deleted within an hour (on the next key generated, plus a daily cleanup cron).
