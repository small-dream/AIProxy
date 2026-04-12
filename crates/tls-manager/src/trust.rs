use std::path::Path;

/// The platform we're running on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Platform::Windows => write!(f, "windows"),
            Platform::Macos => write!(f, "macos"),
            Platform::Linux => write!(f, "linux"),
        }
    }
}

/// Detect the current platform.
pub fn detect_platform() -> Platform {
    if cfg!(target_os = "windows") {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::Macos
    } else {
        Platform::Linux
    }
}

/// Check whether a certificate is trusted on the current platform.
pub fn is_cert_trusted_on_platform(cert_path: &Path, platform: Platform) -> bool {
    match platform {
        Platform::Windows => is_trusted_windows(cert_path),
        Platform::Macos => false, // TODO: implement for macOS
        Platform::Linux => false, // TODO: implement for Linux
    }
}

#[cfg(target_os = "windows")]
fn is_trusted_windows(cert_path: &Path) -> bool {
    use base64::Engine;
    use sha1::{Digest, Sha1};
    use std::process::Command;

    // Read and parse the PEM certificate
    let cert_pem = match std::fs::read_to_string(cert_path) {
        Ok(p) => p,
        Err(_) => return false,
    };

    // Extract base64 content between BEGIN/END markers
    let b64: String = cert_pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let der = match base64::engine::general_purpose::STANDARD
        .decode(b64.replace('\n', "").replace('\r', ""))
    {
        Ok(d) => d,
        Err(_) => return false,
    };

    // Compute SHA-1 thumbprint
    let mut hasher = Sha1::new();
    hasher.update(&der);
    let result = hasher.finalize();
    let thumbprint = result
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ");

    // Use certutil to check if the certificate is in the Root store
    let output = match Command::new("certutil")
        .args(["-store", "-user", "Root"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Also check machine store
    let machine_output = match Command::new("certutil")
        .args(["-store", "Root"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };

    let machine_stdout = String::from_utf8_lossy(&machine_output.stdout);

    stdout.contains(&thumbprint) || machine_stdout.contains(&thumbprint)
}

#[cfg(not(target_os = "windows"))]
fn is_trusted_windows(_cert_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_platform_returns_something() {
        let platform = detect_platform();
        assert!(matches!(
            platform,
            Platform::Windows | Platform::Macos | Platform::Linux
        ));
    }

    #[test]
    fn platform_display_format() {
        assert_eq!(Platform::Windows.to_string(), "windows");
        assert_eq!(Platform::Macos.to_string(), "macos");
        assert_eq!(Platform::Linux.to_string(), "linux");
    }
}
