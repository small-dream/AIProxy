#!/usr/bin/env node

// Verifies the five release version locations agree. When an expected version
// is supplied (CI release workflow passes the tag without a leading `v`), the
// files must also match it, so a mis-tagged release cannot publish artifacts
// whose embedded version differs from latest.json.
//
// Usage:
//   node scripts/check-release-version.mjs            # all five agree
//   node scripts/check-release-version.mjs 0.4.2      # all five equal 0.4.2

import fs from "node:fs";
import process from "node:process";

const read = (path) => fs.readFileSync(path, "utf8");

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

const expectedArg = process.argv[2]?.trim().replace(/^v/, "");
const expected = expectedArg || entries[0][1];
let failed = false;

for (const [file, version] of entries) {
  if (!version) {
    console.error(`✗ Could not read version from ${file}`);
    failed = true;
    continue;
  }
  if (version !== expected) {
    console.error(`✗ ${file}: expected ${expected}, found ${version}`);
    failed = true;
  }
}

if (expectedArg && entries[0][1] !== expectedArg) {
  console.error(`✗ package.json version ${entries[0][1]} does not match tag ${expectedArg}`);
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`✓ Release version ${expected} is consistent across all five files`);
