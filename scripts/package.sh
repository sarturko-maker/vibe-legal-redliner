#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Vibe Legal Redliner — Package for Distribution
# Creates a .zip suitable for Chrome Web Store or manual installation.
# Run from the vibe-legal-extension/ directory.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log() { echo -e "${GREEN}[package]${NC} $1"; }
err() { echo -e "${RED}[package]${NC} $1"; }

# ----------------------------------------------------------------------------
# 1. Read version from manifest.json
# ----------------------------------------------------------------------------

VERSION="$(python3 -c "import json; print(json.load(open('$PROJECT_DIR/manifest.json'))['version'])" 2>/dev/null)" || \
VERSION="$(node -e "console.log(require('$PROJECT_DIR/manifest.json').version)" 2>/dev/null)" || {
  err "Could not read version from manifest.json"
  exit 1
}

ZIP_NAME="vibe-legal-redliner-v${VERSION}.zip"
log "Packaging version ${VERSION}..."

# ----------------------------------------------------------------------------
# 2. Preflight checks
# ----------------------------------------------------------------------------

if [ ! -d "$PROJECT_DIR/pyodide" ]; then
  err "pyodide/ directory not found. Run scripts/setup.sh first."
  exit 1
fi

if [ ! -f "$PROJECT_DIR/src/lib/jszip.min.js" ]; then
  err "src/lib/jszip.min.js not found."
  exit 1
fi

# ----------------------------------------------------------------------------
# 3. Clean and create dist/
# ----------------------------------------------------------------------------

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# ----------------------------------------------------------------------------
# 4. Copy shipping files
# ----------------------------------------------------------------------------

log "Copying files..."

# Manifest
cp "$PROJECT_DIR/manifest.json" "$DIST_DIR/"

# HTML pages
cp "$PROJECT_DIR"/*.html "$DIST_DIR/"

# Source code
cp -r "$PROJECT_DIR/src" "$DIST_DIR/src"

# Python engine
cp -r "$PROJECT_DIR/python" "$DIST_DIR/python"

# Pyodide runtime + wheels
cp -r "$PROJECT_DIR/pyodide" "$DIST_DIR/pyodide"

# Styles
cp -r "$PROJECT_DIR/styles" "$DIST_DIR/styles"

# Icons
cp -r "$PROJECT_DIR/icons" "$DIST_DIR/icons"

# ----------------------------------------------------------------------------
# 5. Remove non-shipping files that may have been copied
# ----------------------------------------------------------------------------

rm -rf "$DIST_DIR/src/__pycache__"

# ----------------------------------------------------------------------------
# 6. Create zip
# ----------------------------------------------------------------------------

log "Creating ${ZIP_NAME}..."
cd "$DIST_DIR"
zip -r -q "$PROJECT_DIR/${ZIP_NAME}" .
cd "$PROJECT_DIR"

# Clean up dist/
rm -rf "$DIST_DIR"

# ----------------------------------------------------------------------------
# 7. Summary
# ----------------------------------------------------------------------------

ZIP_SIZE="$(du -h "$PROJECT_DIR/${ZIP_NAME}" | cut -f1)"
echo ""
log "Done."
echo "  File: ${ZIP_NAME}"
echo "  Size: ${ZIP_SIZE}"
echo "  Path: ${PROJECT_DIR}/${ZIP_NAME}"
