#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Vibe Legal Redliner — Package for Chrome Web Store
# Creates a clean .zip containing only runtime files.
# Run from the vibe-legal-extension/ directory.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[package]${NC} $1"; }
warn() { echo -e "${YELLOW}[package]${NC} $1"; }
err()  { echo -e "${RED}[package]${NC} $1"; }

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

ERRORS=0

if [ ! -d "$PROJECT_DIR/pyodide" ]; then
  err "pyodide/ directory not found. Run scripts/setup.sh first."
  ERRORS=1
fi

if [ ! -f "$PROJECT_DIR/pyodide/pyodide.asm.wasm" ]; then
  err "pyodide/pyodide.asm.wasm not found. Run scripts/setup.sh first."
  ERRORS=1
fi

if [ ! -f "$PROJECT_DIR/src/lib/jszip.min.js" ]; then
  err "src/lib/jszip.min.js not found."
  ERRORS=1
fi

# Check all HTML entry points referenced by manifest
for html in manifest.json popup.html sidepanel.html app.html offscreen.html disclaimer.html; do
  if [ ! -f "$PROJECT_DIR/$html" ]; then
    err "Missing required file: $html"
    ERRORS=1
  fi
done

# Check all icons referenced by manifest
for icon in icons/icon16.png icons/icon48.png icons/icon128.png; do
  if [ ! -f "$PROJECT_DIR/$icon" ]; then
    err "Missing icon: $icon"
    ERRORS=1
  fi
done

# Check critical JS files
for js in src/background.js src/offscreen.js src/app.js src/launcher.js; do
  if [ ! -f "$PROJECT_DIR/$js" ]; then
    err "Missing source file: $js"
    ERRORS=1
  fi
done

if [ "$ERRORS" -ne 0 ]; then
  err "Preflight checks failed. Fix errors above before packaging."
  exit 1
fi

log "Preflight checks passed."

# ----------------------------------------------------------------------------
# 3. Clean and create dist/
# ----------------------------------------------------------------------------

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# ----------------------------------------------------------------------------
# 4. Copy shipping files (explicit list — nothing else gets in)
# ----------------------------------------------------------------------------

log "Copying files..."

# Manifest
cp "$PROJECT_DIR/manifest.json" "$DIST_DIR/"

# HTML pages
cp "$PROJECT_DIR/popup.html" "$DIST_DIR/"
cp "$PROJECT_DIR/sidepanel.html" "$DIST_DIR/"
cp "$PROJECT_DIR/app.html" "$DIST_DIR/"
cp "$PROJECT_DIR/offscreen.html" "$DIST_DIR/"
cp "$PROJECT_DIR/privacy-policy.html" "$DIST_DIR/"
cp "$PROJECT_DIR/disclaimer.html" "$DIST_DIR/"
cp "$PROJECT_DIR/help.html" "$DIST_DIR/"

# Icons
cp -r "$PROJECT_DIR/icons" "$DIST_DIR/icons"

# Styles
cp -r "$PROJECT_DIR/styles" "$DIST_DIR/styles"

# JavaScript source (explicit file list)
mkdir -p "$DIST_DIR/src/lib" "$DIST_DIR/src/utils"
cp "$PROJECT_DIR/src/background.js"     "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/offscreen.js"      "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/app.js"            "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/launcher.js"       "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/config.js"         "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/state.js"          "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/ui.js"             "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/api-handler.js"    "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/file-processing.js" "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/trusted-html.js"   "$DIST_DIR/src/"
cp "$PROJECT_DIR/src/utils/ai-bundle.js" "$DIST_DIR/src/utils/"
cp "$PROJECT_DIR/src/lib/jszip.min.js"  "$DIST_DIR/src/lib/"

# Python engine (only files loaded by offscreen.js — no cli.py or server.py)
mkdir -p "$DIST_DIR/python/adeu/redline" "$DIST_DIR/python/adeu/utils"
cp "$PROJECT_DIR/python/adeu/__init__.py"          "$DIST_DIR/python/adeu/"
cp "$PROJECT_DIR/python/adeu/VERSION"              "$DIST_DIR/python/adeu/"
cp "$PROJECT_DIR/python/adeu/models.py"            "$DIST_DIR/python/adeu/"
cp "$PROJECT_DIR/python/adeu/ingest.py"            "$DIST_DIR/python/adeu/"
cp "$PROJECT_DIR/python/adeu/diff.py"              "$DIST_DIR/python/adeu/"
cp "$PROJECT_DIR/python/adeu/markup.py"            "$DIST_DIR/python/adeu/"
cp "$PROJECT_DIR/python/adeu/redline/__init__.py"  "$DIST_DIR/python/adeu/redline/"
cp "$PROJECT_DIR/python/adeu/redline/engine.py"    "$DIST_DIR/python/adeu/redline/"
cp "$PROJECT_DIR/python/adeu/redline/mapper.py"    "$DIST_DIR/python/adeu/redline/"
cp "$PROJECT_DIR/python/adeu/redline/comments.py"  "$DIST_DIR/python/adeu/redline/"
cp "$PROJECT_DIR/python/adeu/utils/__init__.py"    "$DIST_DIR/python/adeu/utils/"
cp "$PROJECT_DIR/python/adeu/utils/docx.py"        "$DIST_DIR/python/adeu/utils/"

# Pyodide runtime + wheels
cp -r "$PROJECT_DIR/pyodide" "$DIST_DIR/pyodide"

# ----------------------------------------------------------------------------
# 5. Verify nothing unexpected was included
# ----------------------------------------------------------------------------

# These should NOT be in the package
UNEXPECTED=0
for bad in node_modules tests scripts .eslintrc.json vitest.config.js \
           package.json package-lock.json .github .gitignore \
           DEVELOPMENT_LOG.md DISCLAIMER.md README.md SECURITY.md SBOM.md \
           DEPENDENCIES.md CONTRIBUTING.md; do
  if [ -e "$DIST_DIR/$bad" ]; then
    err "Unexpected file/dir in package: $bad"
    UNEXPECTED=1
  fi
done

# cli.py and server.py should not be included
if [ -f "$DIST_DIR/python/adeu/cli.py" ]; then
  err "cli.py should not be packaged (not used at runtime)"
  UNEXPECTED=1
fi
if [ -f "$DIST_DIR/python/adeu/server.py" ]; then
  err "server.py should not be packaged (not used at runtime)"
  UNEXPECTED=1
fi

if [ "$UNEXPECTED" -ne 0 ]; then
  err "Unexpected files found in dist/. Aborting."
  rm -rf "$DIST_DIR"
  exit 1
fi

# ----------------------------------------------------------------------------
# 6. Create zip
# ----------------------------------------------------------------------------

log "Creating ${ZIP_NAME}..."
cd "$DIST_DIR"
zip -r -q "$PROJECT_DIR/${ZIP_NAME}" .
cd "$PROJECT_DIR"

# ----------------------------------------------------------------------------
# 7. Summary
# ----------------------------------------------------------------------------

ZIP_SIZE="$(du -h "$PROJECT_DIR/${ZIP_NAME}" | cut -f1)"
FILE_COUNT="$(cd "$DIST_DIR" && find . -type f | wc -l)"

echo ""
log "Done."
echo ""
echo "  File:  ${ZIP_NAME}"
echo "  Size:  ${ZIP_SIZE}"
echo "  Files: ${FILE_COUNT}"
echo "  Path:  ${PROJECT_DIR}/${ZIP_NAME}"
echo ""

# Print manifest of included files
echo "  Included:"
echo "  ─────────"
echo "  manifest.json"
echo "  popup.html, sidepanel.html, app.html, offscreen.html"
echo "  privacy-policy.html, disclaimer.html, help.html"
echo "  icons/ (3 PNGs)"
echo "  styles/ (3 CSS files)"
echo "  src/ (10 JS modules + 1 lib + 1 util)"
echo "  python/adeu/ (12 Python files — no cli.py or server.py)"
echo "  pyodide/ (5 runtime files + 10 wheels)"
echo ""
echo "  Excluded:"
echo "  ─────────"
echo "  node_modules/, tests/, scripts/, .github/"
echo "  *.md docs, package.json, vitest.config.js, .eslintrc.json"
echo "  python/adeu/cli.py, python/adeu/server.py"

# Clean up dist/
rm -rf "$DIST_DIR"
