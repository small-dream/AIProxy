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
        Platform::Macos => is_trusted_macos(cert_path),
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

    // Compute SHA-1 thumbprint (no spaces — PowerShell Thumbprint property format)
    let mut hasher = Sha1::new();
    hasher.update(&der);
    let thumbprint: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();

    // Query both Current User and Local Machine Root stores via PowerShell.
    // This uses native Windows certificate store APIs and is locale-independent.
    let script = format!(
        "$t = '{thumbprint}'; \
         ($null -ne (Get-ChildItem Cert:\\CurrentUser\\Root | \
           Where-Object {{ $_.Thumbprint -eq $t }})) -or \
         ($null -ne (Get-ChildItem Cert:\\LocalMachine\\Root | \
           Where-Object {{ $_.Thumbprint -eq $t }}))"
    );

    let output = match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };

    String::from_utf8_lossy(&output.stdout).trim() == "True"
}

#[cfg(not(target_os = "windows"))]
fn is_trusted_windows(_cert_path: &Path) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn is_trusted_macos(cert_path: &Path) -> bool {
    use std::process::Command;

    let output = match Command::new("/usr/bin/security")
        .args(["verify-cert", "-c"])
        .arg(cert_path)
        .output()
    {
        Ok(output) => output,
        Err(_) => return false,
    };

    output.status.success()
}

#[cfg(not(target_os = "macos"))]
fn is_trusted_macos(_cert_path: &Path) -> bool {
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
