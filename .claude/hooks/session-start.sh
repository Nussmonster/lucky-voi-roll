#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

echo "=== Lucky Voi Roll — session setup ==="

echo "[1/3] Installing root npm dependencies..."
npm install --prefix "$CLAUDE_PROJECT_DIR"
echo "      done."

echo "[2/3] Installing contract npm dependencies..."
npm install --prefix "$CLAUDE_PROJECT_DIR/contract"
echo "      done."

echo "[3/3] Installing Python dependencies (pyteal + py-algorand-sdk)..."
pip install --quiet pyteal==0.25.0
echo "      done."

echo "=== Setup complete. Run 'npm run compile' to build TEAL artifacts. ==="
