#!/usr/bin/env python3
"""Syncs a Calibre library to the Book Download Tool's private library.

Reads Calibre's catalogue (metadata.db) read-only, so it is safe while Calibre
is open. Uploads one file per book (EPUB preferred) when it is new or changed,
and removes books that are no longer in Calibre. Uses only the standard
library, so it runs with macOS's python3 or Calibre's own Python.

Settings come from config.json next to this script:
    {"site": "https://your-site.vercel.app", "password": "...",
     "library": "/Users/you/Calibre Library"}
"""
import json
import os
import shutil
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.environ.get('CALIBRE_SYNC_CONFIG', os.path.join(HERE, 'config.json'))
LOCK = os.path.join(HERE, 'sync.lock')

# Calibre format -> file extension in the library folder, in order of preference
FORMATS = [('EPUB', 'epub'), ('KEPUB', 'kepub'), ('AZW3', 'azw3'), ('MOBI', 'mobi'),
           ('AZW', 'azw'), ('PDF', 'pdf'), ('CBZ', 'cbz'), ('CBR', 'cbr'), ('TXT', 'txt')]
MAX_SIZE = 500 * 1024 * 1024


def log(*parts):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *parts, flush=True)


def ssl_context():
    context = ssl.create_default_context()
    # macOS keeps its root certificates here; Python builds don't always find them
    for cafile in ('/etc/ssl/cert.pem',):
        if os.path.exists(cafile):
            try:
                context.load_verify_locations(cafile)
            except Exception:
                pass
    return context


CONTEXT = ssl_context()


def call(site, password, payload, timeout=300):
    req = urllib.request.Request(
        site.rstrip('/') + '/api/library/sync',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + password},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CONTEXT) as res:
            return json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as err:
        try:
            message = json.loads(err.read().decode('utf-8')).get('error')
        except Exception:
            message = None
        raise RuntimeError('Server said %s: %s' % (err.code, message or err.reason))


def put_file(url, path, size):
    with open(path, 'rb') as f:
        req = urllib.request.Request(url, data=f, method='PUT', headers={
            'Content-Length': str(size), 'Content-Type': 'application/octet-stream'})
        with urllib.request.urlopen(req, timeout=600, context=CONTEXT) as res:
            res.read()


def find_calibredb(config):
    for candidate in (config.get('calibredb'), '/Applications/calibre.app/Contents/MacOS/calibredb',
                      shutil.which('calibredb')):
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def add_inbox(config, library):
    """Adds books sent from the upload page while logged in to Calibre.

    Calibre skips a book when it already has one with the same title and
    authors. calibredb can't change the library while Calibre is open, so
    books then wait for a later sync."""
    site, password = config['site'], config['password']
    items = call(site, password, {'action': 'inbox'}).get('inbox', [])
    if not items:
        return
    calibredb = find_calibredb(config)
    if not calibredb:
        log('%d book(s) waiting to be added, but calibredb was not found' % len(items))
        return
    for item in items:
        tmpdir = tempfile.mkdtemp()
        try:
            name = os.path.basename(item['filename']) or 'book.epub'
            path = os.path.join(tmpdir, name)
            with urllib.request.urlopen(item['url'], timeout=600, context=CONTEXT) as res, open(path, 'wb') as f:
                shutil.copyfileobj(res, f)
            result = subprocess.run([calibredb, 'add', '--with-library', library, path],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
            output = ' '.join(result.stdout.split())
            if result.returncode != 0:
                log('Could not add %s to Calibre yet (is Calibre open?): %s' % (name, output[-300:]))
                return
            log('Added to Calibre: %s (%s)' % (name, output[-200:]))
            call(site, password, {'action': 'inboxDone', 'id': item['id']})
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


def read_catalogue(library):
    db_path = os.path.join(library, 'metadata.db')
    if not os.path.exists(db_path):
        raise RuntimeError('No Calibre library at %s (metadata.db not found)' % library)
    # Work from a copy so Calibre is never blocked by this script
    tmpdir = tempfile.mkdtemp()
    try:
        copy = os.path.join(tmpdir, 'metadata.db')
        shutil.copyfile(db_path, copy)
        db = sqlite3.connect(copy)
        try:
            authors = {}
            for book, name in db.execute(
                    'SELECT l.book, a.name FROM books_authors_link l JOIN authors a ON a.id = l.author ORDER BY l.id'):
                authors.setdefault(book, []).append(name.replace('|', ','))
            series = dict(db.execute(
                'SELECT l.book, s.name FROM books_series_link l JOIN series s ON s.id = l.series'))
            files = {}
            for book, fmt, name in db.execute('SELECT book, upper(format), name FROM data'):
                files.setdefault(book, {})[fmt] = name
            rows = db.execute('SELECT id, title, author_sort, series_index, path, timestamp, pubdate FROM books').fetchall()
        finally:
            db.close()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    books = []
    for book_id, title, author_sort, series_index, path, added, published in rows:
        available = files.get(book_id, {})
        for fmt, ext in FORMATS:
            if fmt not in available:
                continue
            file_path = os.path.join(library, path, available[fmt] + '.' + ext)
            try:
                st = os.stat(file_path)
            except OSError:
                continue
            if st.st_size == 0 or st.st_size > MAX_SIZE:
                continue
            books.append({
                'id': book_id,
                'title': title,
                'authors': ', '.join(authors.get(book_id, [])),
                'sortAuthor': author_sort or '',
                'series': series.get(book_id, ''),
                'seriesIndex': series_index if book_id in series else None,
                'added': (added or '').replace(' ', 'T', 1) or None,
                'published': (published or '').replace(' ', 'T', 1) or None,
                'format': fmt,
                'size': st.st_size,
                'fingerprint': '%s:%d:%d' % (fmt, st.st_size, int(st.st_mtime)),
                '_path': file_path,
            })
            break
    return books


def self_update(site):
    """Keeps this script in step with the site: the next run uses the new copy."""
    me = os.path.abspath(__file__)
    try:
        with urllib.request.urlopen(site.rstrip('/') + '/calibre-sync/calibre-sync.py', timeout=60, context=CONTEXT) as res:
            latest = res.read()
        with open(me, 'rb') as f:
            current = f.read()
        if latest != current and latest.startswith(b'#!/usr/bin/env python3') and b'def sync(' in latest:
            tmp = me + '.new'
            with open(tmp, 'wb') as f:
                f.write(latest)
            os.replace(tmp, me)
            log('Updated the sync script; the next run uses the new version')
    except Exception as err:
        log('Could not check for a newer sync script:', err)


def sync(config):
    site, password = config['site'], config['password']
    self_update(site)
    library = os.path.expanduser(config.get('library') or '~/Calibre Library')
    try:
        add_inbox(config, library)
    except Exception as err:
        log('Adding new books to Calibre failed:', err)
    books = read_catalogue(library)
    if not books:
        raise RuntimeError('Found no books in %s, so nothing was changed' % library)
    by_id = {b['id']: b for b in books}
    public = {b['id']: {k: v for k, v in b.items() if not k.startswith('_')} for b in books}

    plan = call(site, password, {'action': 'plan', 'books': list(public.values())})
    uploads = plan.get('uploads', [])
    log('%d books in Calibre: %d unchanged, %d to upload, %d removed' % (
        len(books), plan.get('unchanged', 0), len(uploads), plan.get('removed', 0)))
    if plan.get('invalid'):
        log('Skipped books the server rejected:', plan['invalid'])

    failed = 0
    for i, item in enumerate(uploads, 1):
        book = by_id[item['id']]
        for attempt in range(3):
            try:
                put_file(item['url'], book['_path'], book['size'])
                result = call(site, password, {'action': 'commit', 'book': public[book['id']]})
                if result.get('error'):
                    raise RuntimeError(result['error'])
                log('[%d/%d] %s' % (i, len(uploads), book['title']))
                break
            except Exception as err:
                if attempt == 2:
                    failed += 1
                    log('[%d/%d] Failed: %s (%s)' % (i, len(uploads), book['title'], err))
                else:
                    time.sleep(5 * (attempt + 1))
    if failed:
        log('%d book(s) failed; they will be retried next time' % failed)
    else:
        log('Done')
    return failed == 0


def write_config():
    config = {'site': os.environ['SYNC_SITE'], 'password': os.environ['SYNC_PASSWORD'],
              'library': os.environ['SYNC_LIBRARY']}
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(config, f)
    os.chmod(CONFIG, 0o600)
    log('Saved settings to', CONFIG)
    return 0


def main():
    if os.environ.get('CALIBRE_SYNC_SETUP') == '1':
        return write_config()
    try:
        with open(CONFIG) as f:
            config = json.load(f)
    except FileNotFoundError:
        log('No config at %s. Run the installer first.' % CONFIG)
        return 1

    # Only one sync at a time
    import fcntl
    lock = open(LOCK, 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log('Another sync is running')
        return 0

    try:
        return 0 if sync(config) else 1
    except Exception as err:
        log('Sync failed:', err)
        return 1


if __name__ == '__main__':
    sys.exit(main())
