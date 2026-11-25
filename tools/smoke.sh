#!/usr/bin/env bash
# Free UI smoke test, no AI (2026-11-25). Runs before every push (.githooks/pre-push). Usage: tools/smoke.sh [data dir = ~/study]
# Copies the data (no .git) to a temp dir, starts the mock GitHub + a static server + headless Chromium, runs tools/smoke.mjs.
set -u
APPDIR="$(cd "$(dirname "$0")/.." && pwd)"; DATA_SRC="${1:-$HOME/study}"
W="$HOME/snap/chromium/common/stats-smoke"; rm -rf "$W"; mkdir -p "$W/data" "$W/shots" "$W/profile"   # snap Chromium can only use non-hidden dirs
rsync -a --exclude .git --exclude node_modules --exclude 'courses/*/material' "$DATA_SRC/" "$W/data/" || exit 2
PA=8890; PM=8891; PC=9333
python3 -m http.server $PA --bind 127.0.0.1 --directory "$APPDIR" >/dev/null 2>&1 & S1=$!
python3 "$APPDIR/tools/mock-github.py" "$W/data" $PM >/dev/null 2>&1 & S2=$!
CHROME=$(command -v chromium || command -v chromium-browser || command -v google-chrome)
"$CHROME" --headless=new --remote-debugging-port=$PC --user-data-dir="$W/profile" --no-first-run --disable-gpu about:blank >/dev/null 2>&1 & S3=$!
trap 'kill $S1 $S2 $S3 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s "http://127.0.0.1:$PC/json/version" >/dev/null && curl -s "http://127.0.0.1:$PA/" >/dev/null && break; sleep 0.25; done
node "$APPDIR/tools/smoke.mjs" "http://127.0.0.1:$PC" "http://localhost:$PA" "http://localhost:$PM" "$W/shots"
