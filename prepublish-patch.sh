#!/bin/bash
#
# Prepublish: rebuild linked library, reinstall, bump plugin version, publish.
#
# Usage: ./prepublish-patch.sh [major|minor|patch]
#   Defaults to "patch" if no argument given.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUMP="${1:-patch}"

# ── Step 1: Build the library ───────────────────────────────────
echo "Building reolink-baichuan-js..."
cd "${SCRIPT_DIR}/reolink-baichuan-js"
npm run build
echo "Library built."

# ── Step 2: Reinstall in plugin (picks up fresh dist/) ──────────
echo "Installing dependencies..."
cd "${SCRIPT_DIR}"
npm install
echo "Dependencies installed."

# ── Step 3: Bump plugin version ─────────────────────────────────
echo "Bumping plugin version (${BUMP})..."
npm version "${BUMP}" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "New version: ${NEW_VERSION}"

echo ""
echo "Ready to publish. Run:"
echo "  npm publish"
