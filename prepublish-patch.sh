#!/bin/bash
#
# Prepublish: rebuild linked library and reinstall.
# Runs automatically before npm publish via prepublishOnly.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../reolink-baichuan-js"

# ── Step 1: Build the library ───────────────────────────────────
echo "Building reolink-baichuan-js..."
cd "${LIB_DIR}"
npm run build
echo "Library built."

# ── Step 2: Reinstall in plugin (picks up fresh dist/) ──────────
echo "Installing dependencies..."
cd "${SCRIPT_DIR}"
npm install
echo "Dependencies installed."
