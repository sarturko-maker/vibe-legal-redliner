#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Vibe Legal Redliner — Development Setup
# Downloads Pyodide runtime, Python wheels, and npm dependencies.
# Run from the vibe-legal-extension/ directory.
# ============================================================================

PYODIDE_VERSION="0.26.4"
PYODIDE_CDN="https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PYODIDE_DIR="$PROJECT_DIR/pyodide"

# Colors (if terminal supports them)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass_count=0
fail_count=0
failed_files=()

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

log()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[setup]${NC} $1"; }
err()  { echo -e "${RED}[setup]${NC} $1"; }

download() {
  local url="$1" dest="$2"
  local filename
  filename="$(basename "$dest")"

  if [ -f "$dest" ]; then
    echo "  already exists: $filename"
    return 0
  fi

  echo "  downloading: $filename"
  if ! curl -fSL --retry 3 --progress-bar -o "$dest" "$url"; then
    err "Failed to download $filename"
    return 1
  fi
}

verify_hash() {
  local file="$1" expected="$2"
  local filename
  filename="$(basename "$file")"

  if [ ! -f "$file" ]; then
    err "MISSING: $filename"
    fail_count=$((fail_count + 1))
    failed_files+=("$filename (missing)")
    return 1
  fi

  local actual
  actual="$(sha256sum "$file" | cut -d' ' -f1)"

  if [ "$actual" = "$expected" ]; then
    echo "  OK: $filename"
    pass_count=$((pass_count + 1))
    return 0
  else
    err "HASH MISMATCH: $filename"
    err "  expected: $expected"
    err "  actual:   $actual"
    fail_count=$((fail_count + 1))
    failed_files+=("$filename (hash mismatch)")
    return 1
  fi
}

# ----------------------------------------------------------------------------
# 1. npm install
# ----------------------------------------------------------------------------

log "Installing npm dependencies..."
cd "$PROJECT_DIR"
npm install
echo ""

# ----------------------------------------------------------------------------
# 2. Create pyodide/ directory
# ----------------------------------------------------------------------------

log "Setting up Pyodide ${PYODIDE_VERSION}..."
mkdir -p "$PYODIDE_DIR"
echo ""

# ----------------------------------------------------------------------------
# 3. Download Pyodide runtime files
# ----------------------------------------------------------------------------

log "Downloading Pyodide runtime files..."

RUNTIME_FILES=(
  "pyodide.js"
  "pyodide.asm.js"
  "pyodide.asm.wasm"
  "python_stdlib.zip"
  "pyodide-lock.json"
)

for file in "${RUNTIME_FILES[@]}"; do
  download "${PYODIDE_CDN}/${file}" "${PYODIDE_DIR}/${file}"
done
echo ""

# ----------------------------------------------------------------------------
# 4. Download Python wheels (Pyodide-bundled)
# ----------------------------------------------------------------------------

log "Downloading Python wheels (Pyodide CDN)..."

CDN_WHEELS=(
  "micropip-0.6.0-py3-none-any.whl"
  "typing_extensions-4.11.0-py3-none-any.whl"
  "annotated_types-0.6.0-py3-none-any.whl"
  "packaging-23.2-py3-none-any.whl"
  "pydantic_core-2.18.1-cp312-cp312-pyodide_2024_0_wasm32.whl"
  "pydantic-2.7.0-py3-none-any.whl"
  "lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl"
)

for whl in "${CDN_WHEELS[@]}"; do
  download "${PYODIDE_CDN}/${whl}" "${PYODIDE_DIR}/${whl}"
done
echo ""

# ----------------------------------------------------------------------------
# 5. Download Python wheels (PyPI)
# ----------------------------------------------------------------------------

log "Downloading Python wheels (PyPI)..."

declare -A PYPI_WHEELS
PYPI_WHEELS["python_docx-1.2.0-py3-none-any.whl"]="https://files.pythonhosted.org/packages/d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl"
PYPI_WHEELS["diff_match_patch-20241021-py3-none-any.whl"]="https://files.pythonhosted.org/packages/f7/bb/2aa9b46a01197398b901e458974c20ed107935c26e44e37ad5b0e5511e44/diff_match_patch-20241021-py3-none-any.whl"
PYPI_WHEELS["structlog-25.5.0-py3-none-any.whl"]="https://files.pythonhosted.org/packages/a8/45/a132b9074aa18e799b891b91ad72133c98d8042c70f6240e4c5f9dabee2f/structlog-25.5.0-py3-none-any.whl"

for whl in "${!PYPI_WHEELS[@]}"; do
  download "${PYPI_WHEELS[$whl]}" "${PYODIDE_DIR}/${whl}"
done
echo ""

# ----------------------------------------------------------------------------
# 6. Verify SHA-256 hashes
# ----------------------------------------------------------------------------

log "Verifying SHA-256 hashes..."

# Runtime files
verify_hash "${PYODIDE_DIR}/pyodide.js"          "c0069107621d5b942a659e737a12e774cc0451feaa2256f475d72e071d844ec7"
verify_hash "${PYODIDE_DIR}/pyodide.asm.js"       "919560652ed3dad3707cb3a394785da1e046fb13dc0defa162058ff230cb7eed"
verify_hash "${PYODIDE_DIR}/pyodide.asm.wasm"     "b7e66a19427a55010ac3367c1b6c64b893f9826f783412945fdf0c3337f3bc94"
verify_hash "${PYODIDE_DIR}/python_stdlib.zip"    "72894522b791858b9d613ac786b951d8b5094035dcf376313ea24a466810f336"
verify_hash "${PYODIDE_DIR}/pyodide-lock.json"    "cd50b49de944c579045e122fe8628b31f9ce446379f032f36c05e273d38766e0"

# Wheels
verify_hash "${PYODIDE_DIR}/micropip-0.6.0-py3-none-any.whl"                              "d97c0c01748ddbc52a19944c6a6788c6a8969ed13158c06bc63c6eb02779cd98"
verify_hash "${PYODIDE_DIR}/typing_extensions-4.11.0-py3-none-any.whl"                     "696ecd97bd0abc88fc25d376ac06f4233ab16bba3e992c4b37bbc2715240d4e8"
verify_hash "${PYODIDE_DIR}/annotated_types-0.6.0-py3-none-any.whl"                        "50f2adc38958cbac4c343806a8d7554bd987098e332ea5a796c642018455af2a"
verify_hash "${PYODIDE_DIR}/packaging-23.2-py3-none-any.whl"                               "3c30fe6689a35520f2040f4963eae8dbdf6aaa8e326674a13bca3f11514c674a"
verify_hash "${PYODIDE_DIR}/pydantic_core-2.18.1-cp312-cp312-pyodide_2024_0_wasm32.whl"    "f85156f928fbed235b783546dbe6fb38ca72cdc72e48aa8f841ea435c0fb2166"
verify_hash "${PYODIDE_DIR}/pydantic-2.7.0-py3-none-any.whl"                               "750ccf9a0b0b9d8ddb555430510d444c1b00f121e51aa94e3b18a82af4d73a99"
verify_hash "${PYODIDE_DIR}/lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl"              "162c1a8c58fa7da34c2c492b7a572f8d604318d9708f6cd8c3968bfa5fe8a08b"
verify_hash "${PYODIDE_DIR}/python_docx-1.2.0-py3-none-any.whl"                            "3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7"
verify_hash "${PYODIDE_DIR}/diff_match_patch-20241021-py3-none-any.whl"                    "93cea333fb8b2bc0d181b0de5e16df50dd344ce64828226bda07728818936782"
verify_hash "${PYODIDE_DIR}/structlog-25.5.0-py3-none-any.whl"                             "a8453e9b9e636ec59bd9e79bbd4a72f025981b3ba0f5837aebf48f02f37a7f9f"
echo ""

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------

echo "============================================"
if [ "$fail_count" -eq 0 ]; then
  log "Setup complete. ${pass_count}/${pass_count} files verified."
  echo ""
  log "Next steps:"
  echo "  1. Open chrome://extensions"
  echo "  2. Enable Developer Mode"
  echo "  3. Click 'Load unpacked' and select this directory"
else
  err "Setup completed with errors."
  err "${pass_count} passed, ${fail_count} failed:"
  for f in "${failed_files[@]}"; do
    err "  - $f"
  done
  echo ""
  err "Delete the affected files and re-run this script."
  exit 1
fi
