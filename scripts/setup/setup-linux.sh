#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

log() {
  printf '\n[setup-linux] %s\n' "$1"
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

require_sudo() {
  if ! has_command sudo; then
    echo "[setup-linux] sudo is required for package installation" >&2
    exit 1
  fi
}

detect_package_manager() {
  if has_command apt-get; then
    echo "apt"
    return
  fi

  if has_command dnf; then
    echo "dnf"
    return
  fi

  if has_command pacman; then
    echo "pacman"
    return
  fi

  echo "unsupported"
}

install_apt_dependencies() {
  require_sudo

  log "Installing Linux system dependencies with apt"
  sudo apt-get update
  sudo apt-get install -y \
    build-essential \
    curl \
    wget \
    file \
    pkg-config \
    libssl-dev \
    libgtk-3-dev \
    librsvg2-dev \
    libxdo-dev \
    patchelf \
    nodejs \
    npm

  if apt-cache show libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
    sudo apt-get install -y libwebkit2gtk-4.1-dev
  elif apt-cache show libwebkit2gtk-4.0-dev >/dev/null 2>&1; then
    sudo apt-get install -y libwebkit2gtk-4.0-dev
  fi

  if apt-cache show libjavascriptcoregtk-4.1-dev >/dev/null 2>&1; then
    sudo apt-get install -y libjavascriptcoregtk-4.1-dev
  elif apt-cache show libjavascriptcoregtk-4.0-dev >/dev/null 2>&1; then
    sudo apt-get install -y libjavascriptcoregtk-4.0-dev
  fi

  if apt-cache show libayatana-appindicator3-dev >/dev/null 2>&1; then
    sudo apt-get install -y libayatana-appindicator3-dev
  elif apt-cache show libappindicator3-dev >/dev/null 2>&1; then
    sudo apt-get install -y libappindicator3-dev
  fi
}

install_dnf_dependencies() {
  require_sudo

  log "Installing Linux system dependencies with dnf"
  sudo dnf install -y \
    curl \
    wget \
    file \
    gcc \
    gcc-c++ \
    make \
    openssl-devel \
    gtk3-devel \
    librsvg2-devel \
    libxdo-devel \
    patchelf \
    nodejs \
    npm

  if dnf info webkit2gtk4.1-devel >/dev/null 2>&1; then
    sudo dnf install -y webkit2gtk4.1-devel
  elif dnf info webkit2gtk3-devel >/dev/null 2>&1; then
    sudo dnf install -y webkit2gtk3-devel
  fi

  if dnf info libappindicator-gtk3-devel >/dev/null 2>&1; then
    sudo dnf install -y libappindicator-gtk3-devel
  elif dnf info libayatana-appindicator-gtk3-devel >/dev/null 2>&1; then
    sudo dnf install -y libayatana-appindicator-gtk3-devel
  fi
}

install_pacman_dependencies() {
  require_sudo

  log "Installing Linux system dependencies with pacman"
  sudo pacman -Sy --noconfirm
  sudo pacman -S --needed --noconfirm \
    base-devel \
    curl \
    wget \
    file \
    openssl \
    gtk3 \
    librsvg \
    libxdo \
    nodejs \
    npm

  if pacman -Si webkit2gtk-4.1 >/dev/null 2>&1; then
    sudo pacman -S --needed --noconfirm webkit2gtk-4.1
  elif pacman -Si webkit2gtk >/dev/null 2>&1; then
    sudo pacman -S --needed --noconfirm webkit2gtk
  fi

  if pacman -Si libappindicator-gtk3 >/dev/null 2>&1; then
    sudo pacman -S --needed --noconfirm libappindicator-gtk3
  elif pacman -Si libayatana-appindicator >/dev/null 2>&1; then
    sudo pacman -S --needed --noconfirm libayatana-appindicator
  fi
}

ensure_node_and_pnpm() {
  if ! has_command node; then
    echo "[setup-linux] Node.js installation failed or is not on PATH" >&2
    exit 1
  fi

  # Corepack ships with Node.js >= 16.10, but some Debian/Ubuntu `nodejs`
  # packages do not bundle it (M17). Install it explicitly if missing so the
  # script doesn't fail with "command not found" under `set -e`.
  if ! has_command corepack; then
    log "Installing Corepack (not bundled with this Node.js package)"
    sudo apt-get install -y corepack
  fi

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

[setup-linux] Environment is ready.

Next commands:
  pnpm desktop:run:linux
  pnpm desktop:build:linux
  pnpm desktop:bundle:linux
EOF
}

PACKAGE_MANAGER="$(detect_package_manager)"

case "$PACKAGE_MANAGER" in
  apt)
    install_apt_dependencies
    ;;
  dnf)
    install_dnf_dependencies
    ;;
  pacman)
    install_pacman_dependencies
    ;;
  *)
    echo "[setup-linux] Unsupported Linux package manager. Supported: apt, dnf, pacman" >&2
    exit 1
    ;;
esac

ensure_node_and_pnpm
ensure_rustup
ensure_tauri_cli
install_workspace_dependencies
print_summary
