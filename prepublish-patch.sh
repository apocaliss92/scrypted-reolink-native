#!/bin/bash
#
# Prepublish: install deps (including @apocaliss92/nodelink-js from npm),
# bump plugin patch version. Runs automatically before npm publish via prepublishOnly.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# ── Step 1: Install dependencies (pulls latest lib from npm) ────
echo "Installing dependencies..."
npm install
echo "Dependencies installed."

# ── Step 2: Bump plugin patch version ───────────────────────────
echo "Bumping plugin patch version..."
npm version patch --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "Plugin version: ${NEW_VERSION}"
