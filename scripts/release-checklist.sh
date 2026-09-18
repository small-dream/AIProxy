#!/usr/bin/env bash
set -euo pipefail

echo "=== AIProxy Release Checklist ==="
echo ""

echo "[1/6] Version consistency..."
node <<'EOF'
const fs = require("node:fs");

const read = (p) => fs.readFileSync(p, "utf8");
const entries = [
  ["package.json", JSON.parse(read("package.json")).version],
  ["apps/desktop/package.json", JSON.parse(read("apps/desktop/package.json")).version],
  [
    "apps/desktop/src-tauri/tauri.conf.json",
    JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version,
  ],
  [
    "Cargo.toml [workspace.package]",
    (read("Cargo.toml").match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m) || [])[1],
  ],
  [
    "Cargo.lock (aiproxy-desktop)",
    (read("Cargo.lock").match(/\[\[package\]\]\nname = "aiproxy-desktop"\nversion = "([^"]+)"/) ||
      [])[1],
  ],
];

let failed = false;
for (const [file, version] of entries) {
  if (!version) {
    console.error(`✗ Could not read version from ${file}`);
    failed = true;
  }
}
if (new Set(entries.map(([, version]) => version)).size !== 1) {
  console.error("✗ Version mismatch across release files:");
  for (const [file, version] of entries) {
    console.error(`    ${file}: ${version}`);
  }
  failed = true;
}
if (failed) {
  process.exit(1);
}
console.log(`✓ Version consistency passed (${entries[0][1]})`);
EOF
echo ""

echo "[2/6] Typecheck..."
pnpm typecheck
echo "✓ Typecheck passed"
echo ""

echo "[3/6] Lint..."
pnpm lint
echo "✓ Lint passed"
echo ""

echo "[4/6] Frontend Tests..."
pnpm test
echo "✓ Frontend tests passed"
echo ""

echo "[5/6] Rust Tests..."
cargo test --workspace
echo "✓ Rust tests passed"
echo ""

echo "[6/6] Rust Clippy..."
cargo clippy --workspace --all-targets -- -D warnings
echo "✓ Clippy passed"
echo ""

echo "=== All checks passed ==="

echo ""
echo "=== M3.5 Platform Smoke Evidence ==="
echo "Complete scripts/release/m35-smoke-checklist.md on native macOS, Windows, and Linux hosts before promoting the release."
