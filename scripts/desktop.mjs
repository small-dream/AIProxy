#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const desktopDir = path.join(repoRoot, "apps", "desktop");
const tauriDir = path.join(desktopDir, "src-tauri");
const cargoManifestPath = path.join(tauriDir, "Cargo.toml");

const hostPlatform = normalizePlatform(process.platform);
const cli = parseCommandLine(process.argv.slice(2));
const frontendPackageManager = resolveFrontendPackageManager();

if (cli.help || !cli.action) {
  printUsage();
  process.exit(cli.help ? 0 : 1);
}

if (!["run", "build", "bundle"].includes(cli.action)) {
  console.error(`[aiproxy-scripts] Unsupported action "${cli.action}".`);
  printUsage();
  process.exit(1);
}

if (cli.platform) {
  // Normalize so `--platform win32` (Node's process.platform value) is treated
  // the same as `--platform windows`, instead of misreporting a mismatch (L10).
  cli.platform = normalizePlatform(cli.platform);
  if (cli.platform !== hostPlatform) {
    console.error(
      `[aiproxy-scripts] Platform mismatch. Requested ${cli.platform}, current host is ${hostPlatform}. ` +
        "Desktop compile/run/package must be executed on the matching native host.",
    );
    process.exit(1);
  }
}

if (cli.action === "bundle" && !hasCargoTauri()) {
  console.error(
    "[aiproxy-scripts] `cargo tauri` is not installed. Install `cargo-tauri` on this host before running bundle.",
  );
  process.exit(1);
}

const steps = createSteps(cli.action);

for (const step of steps) {
  console.log(`[aiproxy-scripts] ${step.label}`);
  runCommand(step.command, step.args, step.cwd);
}

function createSteps(action) {
  if (action === "run") {
    if (hostPlatform === "macos") {
      if (!hasCargoTauri()) {
        console.error(
          "[aiproxy-scripts] `cargo tauri` is not installed. Install `cargo-tauri` on macOS before running desktop:run.",
        );
        process.exit(1);
      }

      return [
        {
          args: ["tauri", "dev", "--no-watch", ...tauriConfigArgs()],
          command: resolveCommand("cargo"),
          cwd: tauriDir,
          label: "Launching AIProxy desktop application",
        },
      ];
    }

    return [
      {
        args: [...frontendPackageManager.args, "--dir", "apps/desktop", "build"],
        command: frontendPackageManager.command,
        cwd: repoRoot,
        label: "Building desktop frontend bundle",
      },
      {
        args: ["run", "--manifest-path", cargoManifestPath],
        command: resolveCommand("cargo"),
        cwd: repoRoot,
        label: "Launching AIProxy desktop application",
      },
    ];
  }

  if (action === "build") {
    return [
      {
        args: [...frontendPackageManager.args, "--dir", "apps/desktop", "build"],
        command: frontendPackageManager.command,
        cwd: repoRoot,
        label: "Building desktop frontend bundle",
      },
      {
        args: ["build", "--manifest-path", cargoManifestPath],
        command: resolveCommand("cargo"),
        cwd: repoRoot,
        label: "Compiling AIProxy desktop binary",
      },
    ];
  }

  return [
    {
      args: [...frontendPackageManager.args, "--dir", "apps/desktop", "build"],
      command: frontendPackageManager.command,
      cwd: repoRoot,
      label: "Building desktop frontend bundle",
    },
    {
      args: ["tauri", "build", ...tauriConfigArgs(), ...updaterArtifactsConfigArgs()],
      command: resolveCommand("cargo"),
      cwd: tauriDir,
      label: "Building platform bundle with Tauri",
    },
  ];
}

function hasCargoTauri() {
  const result = spawnSync(resolveCommand("cargo"), ["tauri", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: "pipe",
  });

  return result.status === 0;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    shell: shouldUseShell(command),
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`[aiproxy-scripts] Failed to start ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function shouldUseShell(command) {
  return process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
}

function resolveFrontendPackageManager() {
  const corepackCommand = resolveCommand("corepack");
  if (hasCommand(corepackCommand)) {
    return {
      args: ["pnpm"],
      command: corepackCommand,
    };
  }

  const pnpmCommand = resolveCommand("pnpm");
  if (hasCommand(pnpmCommand)) {
    return {
      args: [],
      command: pnpmCommand,
    };
  }

  console.error(
    "[aiproxy-scripts] Neither `corepack` nor `pnpm` is available on PATH. Install pnpm or enable corepack before running desktop commands.",
  );
  process.exit(1);
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

function normalizePlatform(platform) {
  if (platform === "win32") {
    return "windows";
  }

  if (platform === "darwin") {
    return "macos";
  }

  if (platform === "linux") {
    return "linux";
  }

  return platform;
}

function parseCommandLine(argv) {
  const parsed = {
    action: undefined,
    help: false,
    platform: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--help" || current === "-h") {
      parsed.help = true;
      continue;
    }

    if (current === "--platform") {
      parsed.platform = argv[index + 1];
      index += 1;
      continue;
    }

    if (!parsed.action) {
      parsed.action = current;
      continue;
    }
  }

  return parsed;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/desktop.mjs <run|build|bundle> [--platform windows|macos|linux]",
      "",
      "Examples:",
      "  node scripts/desktop.mjs run",
      "  node scripts/desktop.mjs build --platform windows",
      "  node scripts/desktop.mjs bundle --platform macos",
    ].join("\n"),
  );
}

/**
 * Returns the extra Tauri CLI args that enable updater artifacts
 * (`.sig` signatures and, on macOS, the `.app.tar.gz` archive) when the
 * release pipeline opts in via `AIPROXY_UPDATER_ARTIFACTS=true` — set only
 * when `TAURI_SIGNING_PRIVATE_KEY` is configured.
 *
 * `tauri.conf.json` keeps `bundle.createUpdaterArtifacts` at `false` so
 * local builds without a signing key keep working: `tauri build` fails
 * hard when updater signing is requested but no private key is present.
 * The Tauri CLI accepts repeated `--config` values and merges them in
 * order, so this does not clash with the macOS `bundleVersion` override
 * injected by `tauriConfigArgs()`.
 */
function updaterArtifactsConfigArgs() {
  if (process.env.AIPROXY_UPDATER_ARTIFACTS !== "true") {
    return [];
  }
  console.log(
    "[aiproxy-scripts] AIPROXY_UPDATER_ARTIFACTS=true → enabling bundle.createUpdaterArtifacts",
  );
  return ["--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true } })];
}

/**
 * Builds the --config override args for the Tauri CLI so the macOS bundle
 * uses the current git short hash as CFBundleVersion. Injecting it at
 * build/dev time (instead of writing it into tauri.conf.json) keeps the
 * working tree clean on every build, while still showing "Version 0.1.0
 * (64c454b)" in the About dialog instead of the duplicated "Version 0.1.0
 * (0.1.0)".
 */
function tauriConfigArgs() {
  // bundle.macOS.bundleVersion is macOS-specific; injecting it on Windows/Linux
  // is at best ignored and at worst a schema surprise, so only emit it when
  // bundling on macOS (L11).
  if (hostPlatform !== "macos") {
    return [];
  }

  const shortHash = runSilent("git", ["rev-parse", "--short", "HEAD"], repoRoot);

  if (!shortHash) {
    console.warn(
      "[aiproxy-scripts] Could not resolve git short hash; macOS About will fall back to the version string.",
    );
    return [];
  }

  const override = JSON.stringify({ bundle: { macOS: { bundleVersion: shortHash } } });
  console.log(`[aiproxy-scripts] Injecting bundle.macOS.bundleVersion → ${shortHash}`);
  return ["--config", override];
}

function runSilent(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: "pipe",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}
