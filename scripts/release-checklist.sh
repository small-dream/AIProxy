#!/usr/bin/env bash
set -euo pipefail

echo "=== AIProxy Release Checklist ==="
echo ""

echo "[1/9] Version consistency..."
node scripts/check-release-version.mjs
echo "✓ Version consistency passed"
echo ""

echo "[2/9] Typecheck..."
pnpm typecheck
echo "✓ Typecheck passed"
echo ""

echo "[3/9] Lint..."
pnpm lint
echo "✓ Lint passed"
echo ""

echo "[4/9] API contract (docs vs code)..."
pnpm check:api-contract
echo "✓ API contract passed"
echo ""

echo "[5/9] Dependency audit (production)..."
pnpm audit --prod --audit-level high
echo "✓ Production dependency audit passed"
echo ""

echo "[6/9] Frontend Tests..."
pnpm test
echo "✓ Frontend tests passed"
echo ""

echo "[7/9] Build MCP sidecar..."
node scripts/build-mcp-sidecar.mjs --profile debug
echo "✓ MCP sidecar built"
echo ""

echo "[8/9] Rust Tests..."
cargo test --workspace
echo "✓ Rust tests passed"
echo ""

echo "[9/9] Rust Clippy..."
cargo clippy --workspace --all-targets -- -D warnings
echo "✓ Clippy passed"
echo ""

echo "=== All checks passed ==="

echo ""
echo "=== M3.5 Platform Smoke Evidence ==="
echo "Complete scripts/release/m35-smoke-checklist.md on native macOS, Windows, and Linux hosts before promoting the release."
