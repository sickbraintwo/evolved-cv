#!/usr/bin/env bash
#
# deploy-ecv.sh — push the static EvolvedCV site to a remote server (Caddy serves it).
#
# What it does: packs site/ (minus dev-only artifacts), streams it over SSH,
# extracts to <dir>.tmp, then refills <dir> IN PLACE (clear contents + copy).
#
# Why in-place and NOT an mv-swap: when the server serves <dir> via a Docker
# bind mount, renaming/replacing the directory swaps its inode but the container
# stays bound to the OLD inode → Caddy serves an empty/stale dir until you
# restart it. Clearing + refilling the SAME directory preserves the inode, so
# the bind mount keeps working with no container restart needed.
#
# Usage:
#   DEPLOY_SSH=user@your-server.example ./tools/deploy-ecv.sh
#   ./tools/deploy-ecv.sh user@your-server.example [/path/to/evolved-cv/site]
#
# Environment variables:
#   DEPLOY_SSH  — SSH target (user@host), overridden by $1
#   DEPLOY_DIR  — remote directory, overridden by $2
#
# rsync is intentionally NOT used (not present in Git Bash on Windows); tar+ssh
# is the portable equivalent.
set -euo pipefail

REMOTE_HOST="your-server.example"
REMOTE_PATH="/path/to/evolved-cv/site"

SSH_TARGET="${1:-${DEPLOY_SSH:-$REMOTE_HOST}}"
REMOTE_DIR="${2:-${DEPLOY_DIR:-$REMOTE_PATH}}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/site"

if [ -z "$SSH_TARGET" ]; then
  echo "Usage: $0 user@host [remote_dir]   (or set DEPLOY_SSH=user@host)" >&2
  exit 1
fi
if [ ! -f "$SRC/index.html" ]; then
  echo "ERROR: $SRC/index.html not found — run from the repo, src must be site/." >&2
  exit 1
fi

echo "→ Deploying  $SRC  →  ${SSH_TARGET}:${REMOTE_DIR}"

# Pack site/ excluding dev-only files (test page, test suite module, proposals),
# stream to the VPS, extract into a temp dir, then refill REMOTE_DIR IN PLACE
# (clear its contents + copy) so the directory inode — and thus the caddy bind
# mount — is preserved (see header note). find -mindepth 1 -delete empties the
# dir without removing the dir itself.
tar czf - -C "$SRC" \
  --exclude='test.html' \
  --exclude='js/test-suite.js' \
  --exclude='proposals' \
  . | ssh "$SSH_TARGET" "set -e; \
    mkdir -p '${REMOTE_DIR}'; \
    rm -rf '${REMOTE_DIR}.tmp'; mkdir -p '${REMOTE_DIR}.tmp'; \
    tar xzf - -C '${REMOTE_DIR}.tmp'; \
    find '${REMOTE_DIR}' -mindepth 1 -delete; \
    cp -a '${REMOTE_DIR}.tmp/.' '${REMOTE_DIR}/'; \
    rm -rf '${REMOTE_DIR}.tmp'; \
    echo \"  deployed \$(find '${REMOTE_DIR}' -type f | wc -l) files to ${REMOTE_DIR} (in-place)\""

echo "✓ Files are live. On the FIRST deploy, also add the Caddy block and reload"
echo "  Caddy — see docs/DEPLOY.md. On later deploys, nothing else to do."
