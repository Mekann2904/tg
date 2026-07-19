#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT/native/kitty-runtime"

echo "Building kitty-runtime (Rust)..."
(cd "$RUNTIME_DIR" && cargo build --release)
echo "$RUNTIME_DIR/target/release/kitty-runtime"
