# Book Download Tool

Send ebooks to a Kobo or Kindle e-reader through its built-in browser, hosted on Vercel. Based on [send2ereader](https://github.com/daniel-j/send2ereader).

Open the site on the e-reader to get a 4-character key, then open it on a phone or computer, enter the key and pick a book. The e-reader shows a download link for it.

Everything lives in a Postgres database (Neon's free tier works): the pairing keys, and the books themselves, which the upload page sends in 3 MB pieces because Vercel limits a function request to 4.5 MB. EPUBs are converted with bundled copies of [Kepubify](https://github.com/pgaskin/kepubify) for Kobo and KindleGen (to MOBI) for Kindle. The upload page detects which e-reader is showing the key and turns on the matching conversion; if it can't tell, it shows both options. Other files are sent unprocessed.

## Deploy

1. Import this repository as a new project at https://vercel.com/new. Keep the default settings; `vercel.json` sets the build.
2. In the project's **Storage** tab, create a **Neon** Postgres database (the Free plan is enough) and connect it to the project. Any environment variable prefix works. The tables are created on first use.
3. Redeploy so the new environment variables are picked up.

Keys last an hour, or until the e-reader asks for a new one. A key holds up to 10 books (300 MB); the e-reader page lists them and each is downloaded with its own tap. Books can be up to 50 MB, and are deleted 5 minutes after the e-reader downloads them, or after an hour at most (checked while the e-reader page is open, on each key generated, and by a daily cleanup cron), so the free tier's 0.5 GB is plenty.

## Private library (Calibre)

`/library` is a password-protected page listing your Calibre books, with a Send button for each. It uses the same keys and conversions as the upload page.

- **Login:** one passcode of 6 to 12 digits, chosen on the library page the first time it opens (set it straight after deploying, since until then anyone could choose it). It is stored as a scrypt hash in Postgres and can be changed from the page. Logging in lasts 30 days. After 10 wrong passcodes in 15 minutes, logins are refused for 15 minutes. Changing the passcode logs out every browser. Once logged in, you can add a passkey (Touch ID or Face ID, synced through iCloud Keychain) and then log in with one tap; once a passkey exists the passcode stops working (biometric login only). To recover after losing every passkey, set `LIBRARY_ALLOW_PASSCODE=1` on Vercel, redeploy, log in with the passcode, add a passkey, then remove the variable.
- **Sync key:** the sync script authenticates with its own 256-bit key, created under Settings on the library page and pasted into the installer. Only its SHA-256 is stored; creating a new one stops the old one.
- **Storage:** library books are kept in an S3-compatible bucket, because Neon's free tier is too small. Cloudflare R2 is free up to 10 GB and doesn't charge for downloads. Set `S3_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`), `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. `S3_REGION` defaults to `auto`. Postgres holds the catalogue (`library_books`).
- **Sync:** `public/calibre-sync/calibre-sync.py` runs on the computer with Calibre. It reads a copy of Calibre's `metadata.db`, so it is safe while Calibre is open. It uploads one file per book (EPUB first, then KEPUB, AZW3, MOBI, AZW, PDF, CBZ, CBR, TXT) when the book is new or its file changed. It updates titles and authors, and removes books that are gone from Calibre. Files go straight to the bucket through signed URLs. On a Mac, install it with:

  ```
  curl -fsSL https://YOUR-SITE/calibre-sync/install.sh | bash -s -- https://YOUR-SITE
  ```

  This sets up a background job (`~/Library/LaunchAgents/com.bookdownloadtool.calibre-sync.plist`) that syncs at login, every hour, and a few minutes after Calibre's library changes. The log is in `~/Library/Logs/calibre-sync.log`.
- **Into Calibre:** when you're logged in, books sent from the upload page are also kept in an inbox. The next sync adds them to Calibre with `calibredb`, which skips books Calibre already has (same title and authors). `calibredb` can't change the library while Calibre is open, so the book then waits for a later sync.
