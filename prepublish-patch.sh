#!/bin/bash
#
# Prepublish script: build the linked library and patch package.json
# so that local file: dependencies become real npm version references.
#
# Usage: ./prepublish-patch.sh
# Run BEFORE: npm publish
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_JSON="${SCRIPT_DIR}/package.json"
LIB_DIR="${SCRIPT_DIR}/reolink-baichuan-js"

# ── Step 1: Build the library ───────────────────────────────────
echo "Building reolink-baichuan-js..."
cd "${LIB_DIR}"
npm run build
echo "Library built."

# ── Step 2: Read the library version ────────────────────────────
LIB_VERSION=$(node -p "require('./package.json').version")
LIB_NAME=$(node -p "require('./package.json').name")
echo "Library: ${LIB_NAME}@${LIB_VERSION}"

# ── Step 3: Backup and patch package.json ───────────────────────
cd "${SCRIPT_DIR}"
cp "${PKG_JSON}" "${PKG_JSON}.bak"

# Replace file: reference with npm version
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('${PKG_JSON}', 'utf-8'));
const libName = '${LIB_NAME}';
const libVersion = '${LIB_VERSION}';

if (pkg.dependencies[libName] && pkg.dependencies[libName].startsWith('file:')) {
  pkg.dependencies[libName] = libVersion;
  console.log('Patched ' + libName + ': file:... -> ' + libVersion);
}

// Also patch @scrypted/common and @scrypted/rtsp if they are file: refs
for (const [name, ver] of Object.entries(pkg.dependencies)) {
  if (typeof ver === 'string' && ver.startsWith('file:')) {
    // Read the actual version from the linked package
    const linkPath = ver.replace('file:', '');
    try {
      const linkedPkg = JSON.parse(fs.readFileSync(linkPath + '/package.json', 'utf-8'));
      pkg.dependencies[name] = linkedPkg.version;
      console.log('Patched ' + name + ': file:... -> ' + linkedPkg.version);
    } catch (e) {
      console.warn('Could not read ' + linkPath + '/package.json, skipping ' + name);
    }
  }
}

fs.writeFileSync('${PKG_JSON}', JSON.stringify(pkg, null, 2) + '\n');
"

echo ""
echo "package.json patched for publish. Backup at package.json.bak"
echo "Run: npm publish"
echo "After publish, restore with: mv package.json.bak package.json"
