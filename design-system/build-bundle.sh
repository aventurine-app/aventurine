#!/usr/bin/env bash
# Build the upload bundle for syncing to Claude Design (claude.ai/design).
#
# The local component cards link the LIVE app CSS at ../../static/css/* so the
# local canvas mirrors the running app. For the remote project to render
# standalone, this script copies the referenced stylesheets into the bundle and
# rewrites that link (../../static/css/ -> ../static/css/) so it resolves within
# the project root. Output goes to ./.sync (gitignored).
#
# Usage:  ./build-bundle.sh
# Then point DesignSync finalize_plan at the printed localDir and write_files.
set -euo pipefail
cd "$(dirname "$0")"

B=.sync
CSS="style themes dbmodal settings nav ui buttons"   # stylesheets the cards reference

rm -rf "$B"
mkdir -p "$B/components" "$B/static/css"

for f in $CSS; do cp "../static/css/$f.css" "$B/static/css/$f.css"; done
cp _canvas.css index.html README.md "$B/"

for f in components/*.html; do
  sed 's#\.\./\.\./static/css/#../static/css/#g' "$f" > "$B/$f"
done

echo "Bundle built at: $(pwd)/$B"
find "$B" -type f | sort
