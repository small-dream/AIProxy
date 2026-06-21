$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..\..")

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "[setup-windows] $Message"
}

function Test-Command {
  param([string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Ensure-Winget {
  if (-not (Test-Command "winget")) {
    throw "[setup-windows] winget is required on Windows 10/11 to run this setup script."
  }
}

function Install-WingetPackage {
  param(
    [string]$Id,
    [string]$DisplayName,
    [string]$OverrideArgs = ""
  )

  Write-Step "Ensuring $DisplayName"

  # Use $wingetArgs instead of the $args automatic variable, which is reserved
  # for a function's leftover positional parameters and silently misbehaves if
  # any are passed (L12).
  $wingetArgs = @(
    "install",
    "--id", $Id,
    "-e",
    "--accept-package-agreements",
    "--accept-source-agreements"
  )

  if ($OverrideArgs -ne "") {
    $wingetArgs += @("--override", $OverrideArgs)
  }

  & winget @wingetArgs
}

function Refresh-Path {
  $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"

  if (Test-Path "$env:USERPROFILE\.cargo\bin") {
    $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
  }

  if (Test-Path "C:\Program Files\nodejs") {
    $env:Path = "C:\Program Files\nodejs;$env:Path"
  }
}

function Ensure-NodeAndPnpm {
  if (-not (Test-Command "node")) {
    Install-WingetPackage -Id "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS"
    Refresh-Path
  }

  Write-Step "Enabling Corepack"
  & corepack enable
  # Read the pinned pnpm version from package.json instead of hardcoding it, so
  # a packageManager bump doesn't desync the setup script (L19).
  $pnpmSpec = (Get-Content "$PSScriptRoot\..\..\package.json" | ConvertFrom-Json).packageManager
  & corepack prepare $pnpmSpec --activate
}

function Ensure-Rust {
  if (-not (Test-Command "rustup")) {
    Install-WingetPackage -Id "Rustlang.Rustup" -DisplayName "Rustup"
    Refresh-Path
    Write-Step "Setting Rust stable MSVC toolchain"
    & rustup default stable-x86_64-pc-windows-msvc
    & rustup update stable
  } else {
    Write-Step "Rustup already installed; skipping toolchain update"
  }
}

function Ensure-WebView2 {
  Install-WingetPackage -Id "Microsoft.EdgeWebView2Runtime" -DisplayName "Microsoft Edge WebView2 Runtime"
}

function Ensure-BuildTools {
  Install-WingetPackage `
    -Id "Microsoft.VisualStudio.2022.BuildTools" `
    -DisplayName "Visual Studio 2022 Build Tools" `
    -OverrideArgs "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
}

function Ensure-TauriCli {
  Refresh-Path

  # NOTE: `$ErrorActionPreference = "Stop"` does NOT throw on a native
  # process's non-zero exit code — `cargo tauri -V` simply exits non-zero when
  # the subcommand is absent, so the previous `try/catch` never entered its
  # catch block and cargo-tauri was never installed (H7). Check $LASTEXITCODE
  # explicitly instead.
  & cargo tauri -V | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Step "cargo-tauri already installed"
  } else {
    Write-Step "Installing cargo-tauri"
    & cargo install tauri-cli --version "^2.0.0" --locked
  }
}

function Install-WorkspaceDependencies {
  Write-Step "Installing workspace dependencies with pnpm"
  Push-Location $repoRoot
  try {
    & pnpm install
  } finally {
    Pop-Location
  }
}

Ensure-Winget
Ensure-NodeAndPnpm
Ensure-Rust
Ensure-WebView2
Ensure-BuildTools
Ensure-TauriCli
Install-WorkspaceDependencies

Write-Host ""
Write-Host "[setup-windows] Environment is ready."
Write-Host ""
Write-Host "Next commands:"
Write-Host "  pnpm desktop:run:windows"
Write-Host "  pnpm desktop:build:windows"
Write-Host "  pnpm desktop:bundle:windows"
