#!/usr/bin/env bash
set -euo pipefail

echo "=== AIProxy Release Checklist ==="
echo ""

echo "[1/5] Typecheck..."
pnpm typecheck
echo "✓ Typecheck passed"
echo ""

echo "[2/5] Lint..."
pnpm lint
echo "✓ Lint passed"
echo ""

echo "[3/5] Frontend Tests..."
pnpm test
echo "✓ Frontend tests passed"
echo ""

echo "[4/5] Rust Tests..."
cargo test --workspace
echo "✓ Rust tests passed"
echo ""

echo "[5/5] Rust Clippy..."
cargo clippy --workspace -- -D warnings
echo "✓ Clippy passed"
echo ""

echo "=== All checks passed ==="

echo ""
echo "=== M3.5 Platform Smoke Evidence ==="
echo "Complete scripts/release/m35-smoke-checklist.md on native macOS, Windows, and Linux hosts before promoting 0.1.21."
