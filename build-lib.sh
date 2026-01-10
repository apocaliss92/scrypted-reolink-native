#!/bin/bash

# Script per buildare la libreria reolink-baichuan-js e poi fare npm install
# nel repository principale

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/reolink-baichuan-js"

echo "📦 Building reolink-baichuan-js library..."
cd "${LIB_DIR}"
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build della libreria fallito!"
    exit 1
fi

echo "✅ Libreria buildata con successo!"
echo ""
echo "📦 Installing dependencies in main repository..."
cd "${SCRIPT_DIR}"
npm install

if [ $? -ne 0 ]; then
    echo "❌ npm install fallito!"
    exit 1
fi

echo "✅ Tutto completato con successo!"
