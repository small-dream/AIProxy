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
        Platform::Linux => is_trusted_linux(cert_path),
    }
}

#[cfg(target_os = "windows")]
fn is_trusted_windows(cert_path: &Path) -> bool {
    use std::process::Command;

    let thumbprint = match certificate_sha1_thumbprint(cert_path) {
        Ok(thumbprint) => thumbprint,
        Err(error) => {
            tracing::warn!(
                event = "windows_cert_trust_thumbprint_failed",
                path = %cert_path.to_string_lossy(),
                error,
                "windows_cert_trust_thumbprint_failed"
            );
            return false;
        }
    };

    let script = r#"
param([string]$Thumbprint)
$ErrorActionPreference = 'Stop'
$normalized = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()

foreach ($location in @('CurrentUser', 'LocalMachine')) {
  try {
    $certPath = "Cert:\$location\Root\$normalized"
    if (Test-Path -LiteralPath $certPath) {
      'True'
      exit 0
    }
  } catch {}
}

$storeName = [System.Security.Cryptography.X509Certificates.StoreName]::Root
foreach ($locationName in @('CurrentUser', 'LocalMachine')) {
  $store = $null
  try {
    $storeLocation = [System.Enum]::Parse(
      [System.Security.Cryptography.X509Certificates.StoreLocation],
      $locationName
    )
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
      $storeName,
      $storeLocation
    )
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    $matches = $store.Certificates.Find(
      [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
      $normalized,
      $false
    )
    if ($matches.Count -gt 0) {
      'True'
      exit 0
    }
  } catch {
  } finally {
    if ($null -ne $store) {
      $store.Close()
    }
  }
}

'False'
"#;

    let output = match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .arg(&thumbprint)
        .output()
    {
        Ok(o) => o,
        Err(error) => {
            tracing::warn!(
                event = "windows_cert_trust_check_spawn_failed",
                error = %error,
                "windows_cert_trust_check_spawn_failed"
            );
            return false;
        }
    };

    if !output.status.success() {
        tracing::warn!(
            event = "windows_cert_trust_check_failed",
            thumbprint,
            status = ?output.status.code(),
            stderr = %String::from_utf8_lossy(&output.stderr).trim(),
            "windows_cert_trust_check_failed"
        );
        return false;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("True"))
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

#[cfg(target_os = "linux")]
fn is_trusted_linux(cert_path: &Path) -> bool {
    use base64::Engine;
    use sha1::{Digest, Sha1};

    let cert_pem = match std::fs::read_to_string(cert_path) {
        Ok(p) => p,
        Err(_) => return false,
    };

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

    let mut hasher = Sha1::new();
    hasher.update(&der);
    let fingerprint: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":");

    let search_dirs: &[&str] = &[
        "/usr/local/share/ca-certificates/",
        "/etc/pki/ca-trust/source/anchors/",
    ];

    for dir in search_dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    let ext_lower = ext.to_string_lossy().to_ascii_lowercase();
                    if ext_lower != "crt" && ext_lower != "pem" && ext_lower != "cer" {
                        continue;
                    }
                }
                if let Ok(other_pem) = std::fs::read_to_string(&path) {
                    let other_b64: String = other_pem
                        .lines()
                        .filter(|line| !line.starts_with("-----"))
                        .collect();
                    if let Ok(other_der) = base64::engine::general_purpose::STANDARD
                        .decode(other_b64.replace('\n', "").replace('\r', ""))
                    {
                        let mut other_hasher = Sha1::new();
                        other_hasher.update(&other_der);
                        let other_fingerprint: String = other_hasher
                            .finalize()
                            .iter()
                            .map(|byte| format!("{byte:02X}"))
                            .collect::<Vec<_>>()
                            .join(":");
                        if fingerprint == other_fingerprint {
                            return true;
                        }
                    }
                }
            }
        }
    }

    false
}

#[cfg(not(target_os = "linux"))]
fn is_trusted_linux(_cert_path: &Path) -> bool {
    false
}

#[cfg(any(target_os = "windows", test))]
fn certificate_sha1_thumbprint(cert_path: &Path) -> Result<String, &'static str> {
    use base64::Engine;
    use sha1::{Digest, Sha1};

    let cert_pem = std::fs::read_to_string(cert_path).map_err(|_| "read certificate")?;
    let b64: String = cert_pem
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("-----") && !line.is_empty())
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "decode certificate")?;

    let mut hasher = Sha1::new();
    hasher.update(&der);
    let thumbprint: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();

    if !thumbprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid thumbprint");
    }

    Ok(thumbprint)
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

    #[test]
    fn computes_uppercase_sha1_thumbprint_from_pem() {
        let cert = crate::RootCaPair::generate().unwrap();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let cert_path = std::env::temp_dir().join(format!(
            "aiproxy-thumbprint-test-{}-{nanos}.pem",
            std::process::id()
        ));
        std::fs::write(&cert_path, cert.cert_pem()).unwrap();

        let thumbprint = certificate_sha1_thumbprint(&cert_path).unwrap();
        let _ = std::fs::remove_file(&cert_path);

        assert_eq!(thumbprint.len(), 40);
        assert!(thumbprint.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(thumbprint, thumbprint.to_ascii_uppercase());
    }
}
