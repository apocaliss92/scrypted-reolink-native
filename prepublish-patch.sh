#!/bin/bash
#
# Prepublish: build linked library, reinstall, bump plugin patch version.
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

# ── Step 3: Bump plugin patch version ───────────────────────────
echo "Bumping plugin patch version..."
npm version patch --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "Plugin version: ${NEW_VERSION}"
