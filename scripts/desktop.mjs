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
  console.error(`[pharles-scripts] Unsupported action "${cli.action}".`);
  printUsage();
  process.exit(1);
}

if (cli.platform && cli.platform !== hostPlatform) {
  console.error(
    `[pharles-scripts] Platform mismatch. Requested ${cli.platform}, current host is ${hostPlatform}. ` +
      "Desktop compile/run/package must be executed on the matching native host.",
  );
  process.exit(1);
}

if (cli.action === "bundle" && !hasCargoTauri()) {
  console.error(
    "[pharles-scripts] `cargo tauri` is not installed. Install `cargo-tauri` on this host before running bundle.",
  );
  process.exit(1);
}

const steps = createSteps(cli.action);

for (const step of steps) {
  console.log(`[pharles-scripts] ${step.label}`);
  runCommand(step.command, step.args, step.cwd);
}

function createSteps(action) {
  if (action === "run") {
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
        label: "Launching Pharles desktop application",
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
        label: "Compiling Pharles desktop binary",
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
      args: ["tauri", "build"],
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
    console.error(`[pharles-scripts] Failed to start ${command}: ${result.error.message}`);
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
    "[pharles-scripts] Neither `corepack` nor `pnpm` is available on PATH. Install pnpm or enable corepack before running desktop commands.",
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
