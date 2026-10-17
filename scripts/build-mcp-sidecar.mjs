#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const tauriDir = path.join(repoRoot, "apps", "desktop", "src-tauri");
const binariesDir = path.join(tauriDir, "binaries");

const cli = parseCommandLine(process.argv.slice(2));
if (cli.help) {
  printUsage();
  process.exit(0);
}

const profile = cli.profile ?? "debug";
if (!["debug", "release"].includes(profile)) {
  console.error(`[aiproxy-mcp] Unsupported profile "${profile}". Use debug or release.`);
  process.exit(1);
}

const triple = resolveTargetTriple();
const targetDirectory = resolveTargetDirectory();
const executableName = process.platform === "win32" ? "aiproxy-mcp.exe" : "aiproxy-mcp";
const profileDirectory = profile === "release" ? "release" : "debug";
const source = path.join(targetDirectory, profileDirectory, executableName);
const bundledName = `aiproxy-mcp-${triple}${process.platform === "win32" ? ".exe" : ""}`;
const bundledPath = path.join(binariesDir, bundledName);

console.log(`[aiproxy-mcp] Building sidecar (${profile}, ${triple})`);
const buildArgs = ["build", "-p", "aiproxy-mcp", "--bin", "aiproxy-mcp"];
if (profile === "release") {
  buildArgs.push("--release");
}
run("cargo", buildArgs, repoRoot);

if (!fs.existsSync(source)) {
  console.error(`[aiproxy-mcp] Cargo completed but the sidecar was not found at ${source}`);
  process.exit(1);
}

fs.mkdirSync(binariesDir, { recursive: true });
fs.copyFileSync(source, bundledPath);
if (process.platform !== "win32") {
  fs.chmodSync(bundledPath, 0o755);
}

// Keep the runtime resolver working in dev even when Tauri did not copy the
// external binary next to the desktop executable yet.
const adjacent = path.join(targetDirectory, profileDirectory, executableName);
if (path.resolve(adjacent) !== path.resolve(source)) {
  fs.copyFileSync(source, adjacent);
  if (process.platform !== "win32") {
    fs.chmodSync(adjacent, 0o755);
  }
}

console.log(`[aiproxy-mcp] Sidecar ready: ${bundledPath}`);

function resolveTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    return process.env.TAURI_ENV_TARGET_TRIPLE;
  }
  const result = spawnSync("rustc", ["-vV"], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    console.error("[aiproxy-mcp] Could not resolve the host target triple with `rustc -vV`.");
    process.exit(1);
  }
  const match = result.stdout.match(/^host:\s*(\S+)$/m);
  if (!match) {
    console.error("[aiproxy-mcp] `rustc -vV` did not report a host triple.");
    process.exit(1);
  }
  return match[1];
}

function resolveTargetDirectory() {
  if (process.env.CARGO_TARGET_DIR) {
    return path.resolve(repoRoot, process.env.CARGO_TARGET_DIR);
  }
  const result = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error("[aiproxy-mcp] Could not resolve Cargo's target directory.");
    process.exit(1);
  }
  try {
    return JSON.parse(result.stdout).target_directory;
  } catch (error) {
    console.error(`[aiproxy-mcp] Invalid cargo metadata: ${error.message}`);
    process.exit(1);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[aiproxy-mcp] Failed to start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseCommandLine(argv) {
  const parsed = { help: false, profile: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") parsed.help = true;
    if (value === "--profile") {
      parsed.profile = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function printUsage() {
  console.log("Usage: node scripts/build-mcp-sidecar.mjs [--profile debug|release]");
}
