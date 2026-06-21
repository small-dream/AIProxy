#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

log() {
  printf '\n[setup-macos] %s\n' "$1"
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

ensure_xcode_clt() {
  if xcode-select -p >/dev/null 2>&1; then
    log "Xcode Command Line Tools already installed"
    return
  fi

  log "Installing Xcode Command Line Tools"
  xcode-select --install || true
  log "Finish the Xcode Command Line Tools installation dialog, then rerun this script"
  exit 1
}

ensure_homebrew() {
  if has_command brew; then
    log "Homebrew already installed"
    return
  fi

  log "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_brew_formula() {
  local formula="$1"
  local command_name="${2:-$1}"

  if has_command "$command_name"; then
    log "$formula already available"
    return
  fi

  log "Installing $formula with Homebrew"
  brew install "$formula"
}

ensure_node_and_pnpm() {
  ensure_brew_formula node node

  log "Enabling Corepack"
  corepack enable
  corepack prepare pnpm@10.0.0 --activate
}

ensure_rustup() {
  if ! has_command rustup; then
    log "Installing rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    export PATH="$HOME/.cargo/bin:$PATH"
    log "Setting Rust stable toolchain"
    rustup default stable
    rustup update stable
  else
    log "rustup already installed; skipping toolchain update"
  fi
}

ensure_tauri_cli() {
  if cargo tauri -V >/dev/null 2>&1; then
    log "cargo-tauri already installed"
    return
  fi

  log "Installing cargo-tauri"
  cargo install tauri-cli --version "^2.0.0" --locked
}

install_workspace_dependencies() {
  log "Installing workspace dependencies with pnpm"
  (cd "$REPO_ROOT" && pnpm install)
}

print_summary() {
  cat <<EOF

[setup-macos] Environment is ready.

Next commands:
  pnpm desktop:run:macos
  pnpm desktop:build:macos
  pnpm desktop:bundle:macos
EOF
}

ensure_xcode_clt
ensure_homebrew
ensure_node_and_pnpm
ensure_rustup
ensure_tauri_cli
install_workspace_dependencies
print_summary
