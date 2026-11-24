#!/bin/bash
# Installs the Calibre sync on a Mac. Run it from Terminal with your site's address:
#
#   curl -fsSL https://YOUR-SITE/calibre-sync/install.sh | bash -s -- https://YOUR-SITE
#
# It asks for the library password, then syncs once and sets up a background job
# that syncs at login, every hour, and shortly after Calibre's library changes.
set -euo pipefail

SITE="${1:-}"
SITE="${SITE%/}"
if [ -z "$SITE" ]; then
	read -r -p "Your site's address (https://...): " SITE < /dev/tty
	SITE="${SITE%/}"
fi
case "$SITE" in https://*) ;; *) echo "The address should start with https://"; exit 1 ;; esac

DIR="$HOME/Library/Application Support/BookDownloadTool"
LABEL="com.bookdownloadtool.calibre-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/calibre-sync.log"

LIBRARY="$HOME/Calibre Library"
if [ ! -f "$LIBRARY/metadata.db" ]; then
	read -r -p "Path to your Calibre library folder: " LIBRARY < /dev/tty
	LIBRARY="${LIBRARY/#\~/$HOME}"
fi
if [ ! -f "$LIBRARY/metadata.db" ]; then
	echo "No Calibre library found at $LIBRARY"
	exit 1
fi

read -r -s -p "Library password (the LIBRARY_PASSWORD you set on Vercel): " PASSWORD < /dev/tty
echo

mkdir -p "$DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
curl -fsSL "$SITE/calibre-sync/calibre-sync.py" -o "$DIR/calibre-sync.py"

# Pick a Python: Homebrew's, Apple's (only if the developer tools are installed,
# otherwise running it pops up an install dialog), or the one inside Calibre.
PYTHON=()
for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3; do
	if [ -x "$candidate" ]; then PYTHON=("$candidate"); break; fi
done
if [ ${#PYTHON[@]} -eq 0 ] && xcode-select -p >/dev/null 2>&1 && [ -x /usr/bin/python3 ]; then
	PYTHON=(/usr/bin/python3)
fi
if [ ${#PYTHON[@]} -eq 0 ] && [ -x /Applications/calibre.app/Contents/MacOS/calibre-debug ]; then
	PYTHON=(/Applications/calibre.app/Contents/MacOS/calibre-debug -e)
fi
if [ ${#PYTHON[@]} -eq 0 ]; then
	echo "Couldn't find Python or Calibre in /Applications."
	exit 1
fi

# Settings, readable only by you
CALIBRE_SYNC_SETUP=1 SYNC_SITE="$SITE" SYNC_PASSWORD="$PASSWORD" SYNC_LIBRARY="$LIBRARY" \
	"${PYTHON[@]}" "$DIR/calibre-sync.py"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
ARGS=""
for part in "${PYTHON[@]}" "$DIR/calibre-sync.py"; do
	ARGS="$ARGS<string>$(xml "$part")</string>"
done

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array>$ARGS</array>
	<key>RunAtLoad</key><true/>
	<key>StartInterval</key><integer>3600</integer>
	<key>WatchPaths</key><array><string>$(xml "$LIBRARY/metadata.db")</string></array>
	<key>ThrottleInterval</key><integer>300</integer>
	<key>LowPriorityIO</key><true/>
	<key>ProcessType</key><string>Background</string>
	<key>StandardOutPath</key><string>$(xml "$LOG")</string>
	<key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF

echo "Syncing now. The first sync uploads the whole library and can take a while."
"${PYTHON[@]}" "$DIR/calibre-sync.py" 2>&1 | tee -a "$LOG" || echo "The first sync had a problem (see above). The background job will retry."

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo
echo "Installed. Your library will sync at login, every hour, and a few minutes after"
echo "you change it in Calibre. Log: $LOG"
