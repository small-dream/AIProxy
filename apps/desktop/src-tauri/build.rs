use std::{env, path::Path, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=AIPROXY_BUILD_NUMBER");
    println!("cargo:rerun-if-changed=../../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../../.git/refs");

    let build_number = env::var("AIPROXY_BUILD_NUMBER")
        .ok()
        .filter(|value| is_valid_build_number(value))
        .unwrap_or_else(|| git_commit_count().unwrap_or_else(|| "0".to_string()));

    println!("cargo:rustc-env=AIPROXY_BUILD_NUMBER={build_number}");

    let git_hash = env::var("AIPROXY_GIT_HASH")
        .ok()
        .filter(|value| is_valid_git_hash(value))
        .unwrap_or_else(|| git_short_hash().unwrap_or_else(|| "unknown".to_string()));

    println!("cargo:rustc-env=AIPROXY_GIT_HASH={git_hash}");

    tauri_build::build()
}

fn git_commit_count() -> Option<String> {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").ok()?;
    let repository_root = Path::new(&manifest_dir).join("../../..");
    let output = Command::new("git")
        .args([
            "-C",
            repository_root.to_str()?,
            "rev-list",
            "--count",
            "HEAD",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let count = String::from_utf8(output.stdout).ok()?.trim().to_string();
    is_valid_build_number(&count).then_some(count)
}

fn is_valid_build_number(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
}

fn git_short_hash() -> Option<String> {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").ok()?;
    let repository_root = Path::new(&manifest_dir).join("../../..");
    let output = Command::new("git")
        .args([
            "-C",
            repository_root.to_str()?,
            "rev-parse",
            "--short",
            "HEAD",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let hash = String::from_utf8(output.stdout).ok()?.trim().to_string();
    is_valid_git_hash(&hash).then_some(hash)
}

fn is_valid_git_hash(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_hexdigit())
}
