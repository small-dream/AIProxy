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

    tauri_build::build()
}

fn git_commit_count() -> Option<String> {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").ok()?;
    let repository_root = Path::new(&manifest_dir).join("../../..");
    let output = Command::new("git")
        .args(["-C", repository_root.to_str()?, "rev-list", "--count", "HEAD"])
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
