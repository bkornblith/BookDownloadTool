# Book Download Tool

Send ebooks to a Kobo or Kindle e-reader through its built-in browser, hosted on Vercel. Based on [send2ereader](https://github.com/daniel-j/send2ereader).

Open the site on the e-reader to get a 4-character key, then open it on a phone or computer, enter the key and pick a book. The e-reader shows a download link for it.

Everything lives in a Postgres database (Neon's free tier works): the pairing keys, and the books themselves, which the upload page sends in 3 MB pieces because Vercel limits a function request to 4.5 MB. EPUBs are converted with bundled copies of [Kepubify](https://github.com/pgaskin/kepubify) for Kobo and KindleGen (to MOBI) for Kindle. The upload page detects which e-reader is showing the key and turns on the matching conversion; if it can't tell, it shows both options. Other files are sent unprocessed.

## Deploy

1. Import this repository as a new project at https://vercel.com/new. Keep the default settings; `vercel.json` sets the build.
2. In the project's **Storage** tab, create a **Neon** Postgres database (the Free plan is enough) and connect it to the project. Any environment variable prefix works. The tables are created on first use.
3. Redeploy so the new environment variables are picked up.

Keys last an hour, or until the e-reader asks for a new one. Books can be up to 50 MB, and are deleted 5 minutes after the e-reader downloads them, or after an hour at most (checked while the e-reader page is open, on each key generated, and by a daily cleanup cron), so the free tier's 0.5 GB is plenty.
