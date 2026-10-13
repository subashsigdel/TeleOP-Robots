#!/usr/bin/env bash
# Push the dashboard to the Jetson over SSH.
#
#   ./deploy.sh            copy files
#   ./deploy.sh --serve    copy files, then (re)start the web server on the Jetson
#
# Override defaults with env vars, e.g.  REMOTE_HOST=100.100.1.2 ./deploy.sh
set -euo pipefail

REMOTE_USER="${REMOTE_USER:-aisense-jetson3}"
REMOTE_HOST="${REMOTE_HOST:-100.100.1.1}"
REMOTE_DIR="${REMOTE_DIR:-/home/aisense-jetson3/Desktop/rover}"
PORT="${PORT:-8765}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${REMOTE_USER}@${REMOTE_HOST}"

echo "→ Deploying ${SRC_DIR}"
echo "  to ${TARGET}:${REMOTE_DIR}"

ssh "${TARGET}" "mkdir -p '${REMOTE_DIR}'"

FILES=(index.html css js assets README.md)

if ssh "${TARGET}" "command -v rsync >/dev/null"; then
  # Only changed files are sent. Nothing on the Jetson is deleted.
  rsync -avz --human-readable \
    --exclude '.git' --exclude 'deploy.sh' --exclude 'Dashboard_Design.png' \
    "${FILES[@]/#/${SRC_DIR}/}" "${TARGET}:${REMOTE_DIR}/"
else
  echo "  (rsync not found on the Jetson, falling back to scp)"
  scp -r "${FILES[@]/#/${SRC_DIR}/}" "${TARGET}:${REMOTE_DIR}/"
fi

echo "✓ Files copied."

if [[ "${1:-}" == "--serve" ]]; then
  echo "→ Starting web server on ${REMOTE_HOST}:${PORT}"
  ssh "${TARGET}" "
    cd '${REMOTE_DIR}' &&
    pkill -f 'http.server ${PORT}' 2>/dev/null || true
    nohup python3 -m http.server ${PORT} --bind 0.0.0.0 > /tmp/rover-dashboard.log 2>&1 &
    sleep 1
    pgrep -f 'http.server ${PORT}' >/dev/null && echo '✓ Server running' || { echo '✗ Server failed to start:'; cat /tmp/rover-dashboard.log; exit 1; }
  "
  echo "  Open: http://${REMOTE_HOST}:${PORT}/?demo"
  echo "  Stop: ssh ${TARGET} \"pkill -f 'http.server ${PORT}'\""
fi
