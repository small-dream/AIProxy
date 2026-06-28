#!/usr/bin/env node

// Clears build *caches* (not build outputs) so the next build regenerates them
// from scratch:
//   - Rust workspace `target/` via `cargo clean`. The root Cargo.toml is a
//     single workspace whose members include apps/desktop/src-tauri and every
//     crate, so they all share one target dir — one `cargo clean` at the repo
//     root covers everything.
//   - Vite caches (`<pkg>/node_modules/.vite`) across the pnpm workspace.
//
// `dist/` (frontend build output) is intentionally left untouched; rerun
// `pnpm build` to refresh it. This script uses Node fs APIs plus a spawned
// `cargo`, so it behaves identically on Windows, macOS, and Linux.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

cleanViteCaches();
cleanRustTarget();

function cleanViteCaches() {
  const caches = findNamedDirs(repoRoot, ".vite", (parent) => path.basename(parent) === "node_modules");
  if (caches.length === 0) {
    console.log("[aiproxy-scripts] No Vite caches (node_modules/.vite) found.");
    return;
  }

  for (const cache of caches) {
    const bytes = directorySize(cache);
    fs.rmSync(cache, { recursive: true, force: true });
    console.log(`[aiproxy-scripts] Removed Vite cache ${rel(cache)} (${formatBytes(bytes)})`);
  }
}

function cleanRustTarget() {
  const cargo = resolveCommand("cargo");
  if (!hasCommand(cargo)) {
    console.warn("[aiproxy-scripts] `cargo` not found on PATH; skipping Rust target clean.");
    return;
  }

  console.log("[aiproxy-scripts] Running `cargo clean` (Rust workspace target/)...");
  const result = spawnSync(cargo, ["clean"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: shouldUseShell(cargo),
  });

  if (result.error) {
    console.error(`[aiproxy-scripts] Failed to start cargo: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Walks the repo for directories named `name` that pass `accept(parentDir)`.
// Skips `.git`/`target` and never follows dependency symlinks (pnpm's `.pnpm`
// store exposes packages as symlinks, which isDirectory() reports as false),
// so traversal stays fast even with node_modules present.
function findNamedDirs(root, name, accept, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // Unreadable dir (permissions/race) — nothing to clean here, move on.
    return acc;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".git" || entry.name === "target") {
      continue;
    }

    const child = path.join(root, entry.name);
    if (entry.name === name && accept(root)) {
      acc.push(child);
      continue; // do not recurse into the matched cache itself
    }
    findNamedDirs(child, name, accept, acc);
  }
  return acc;
}

function directorySize(dir, total = { value: 0 }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Concurrent deletion during sizing is harmless; report what we have.
    return total;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      directorySize(child, total);
    } else {
      try {
        total.value += fs.statSync(child).size;
      } catch {
        // File vanished mid-walk; skip it.
      }
    }
  }
  return total.value;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function rel(target) {
  return path.relative(repoRoot, target) || target;
}

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: shouldUseShell(command),
    stdio: "pipe",
  });
  return result.error === undefined && result.status === 0;
}

function resolveCommand(command) {
  if (process.platform === "win32" && (command === "corepack" || command === "pnpm")) {
    return `${command}.cmd`;
  }
  return command;
}

function shouldUseShell(command) {
  return process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
}
