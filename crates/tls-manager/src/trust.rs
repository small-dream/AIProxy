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
    use aiproxy_sys_util::CommandExt;
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
        .no_window()
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

    // M9: a PEM file may contain MULTIPLE concatenated certificates (e.g. the
    // Debian/Ubuntu `/etc/ssl/certs/ca-certificates.crt` bundle has hundreds).
    // Computing one fingerprint over the whole concatenated DER blob never
    // matches a single certificate, so the trust check permanently mis-reported
    // "not trusted" on those distros. Split into individual PEM blocks and
    // fingerprint each; the cert is trusted if any of its fingerprints matches
    // any certificate in any trust-store directory.
    let target_fingerprints = pem_sha1_fingerprints(&cert_pem);
    if target_fingerprints.is_empty() {
        return false;
    }

    // Source anchor directories: certificates pending `update-ca-certificates` /
    // `update-ca-trust` (Debian/Ubuntu and RHEL/Fedora respectively).
    let source_dirs: &[&str] = &[
        "/usr/local/share/ca-certificates/",
        "/etc/pki/ca-trust/source/anchors/",
    ];
    // The live trust store directory: after `update-ca-certificates`, certs are
    // installed here as subject-hash-named files (e.g. `a1b2c3d4.0`) with no
    // friendly extension. Checking only the source dirs missed certs that were
    // already installed (source .crt may be removed/renamed post-update), so the
    // UI reported "not trusted" even after a successful install (M5).
    let live_dir: &str = "/etc/ssl/certs/";

    let check_dir = |dir: &str, require_cert_ext: bool| -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if require_cert_ext {
                if let Some(ext) = path.extension() {
                    let ext_lower = ext.to_string_lossy().to_ascii_lowercase();
                    if ext_lower != "crt" && ext_lower != "pem" && ext_lower != "cer" {
                        continue;
                    }
                }
            }
            if let Ok(other_pem) = std::fs::read_to_string(&path) {
                // Other files may also be bundles; compare every cert in the
                // store file against every target fingerprint.
                let other_fingerprints = pem_sha1_fingerprints(&other_pem);
                if other_fingerprints
                    .iter()
                    .any(|fp| target_fingerprints.contains(fp))
                {
                    return true;
                }
            }
        }
        false
    };

    if source_dirs.iter().any(|dir| check_dir(dir, true)) {
        return true;
    }
    if check_dir(live_dir, false) {
        return true;
    }

    false
}

/// Split a PEM blob into individual `BEGIN/END CERTIFICATE` blocks and return
/// the SHA-1 fingerprint of each DER-encoded certificate. A PEM file may contain
/// several concatenated certificates (a CA bundle); fingerprinting each
/// separately is required to match against single-certificate inputs (M9).
#[cfg(target_os = "linux")]
fn pem_sha1_fingerprints(pem: &str) -> Vec<String> {
    use base64::Engine;
    use sha1::{Digest, Sha1};

    // Collect base64 lines per block delimited by BEGIN/END CERTIFICATE fences.
    // This is more robust than stripping all fence lines at once (which would
    // concatenate every cert's base64 into one blob).
    let mut fingerprints = Vec::new();
    let mut in_block = false;
    let mut b64 = String::new();

    for line in pem.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("-----BEGIN CERTIFICATE-----") {
            in_block = true;
            b64.clear();
        } else if trimmed.starts_with("-----END CERTIFICATE-----") {
            if in_block {
                if let Ok(der) =
                    base64::engine::general_purpose::STANDARD.decode(b64.replace(['\n', '\r'], ""))
                {
                    let mut hasher = Sha1::new();
                    hasher.update(&der);
                    let fingerprint: String = hasher
                        .finalize()
                        .iter()
                        .map(|byte| format!("{byte:02X}"))
                        .collect::<Vec<_>>()
                        .join(":");
                    fingerprints.push(fingerprint);
                }
            }
            in_block = false;
            b64.clear();
        } else if in_block {
            b64.push_str(trimmed);
        }
    }

    // Fallback: if the file had no recognized BEGIN/END fences (some distros
    // store a bare base64 DER), treat the whole content as one certificate.
    if fingerprints.is_empty() {
        let raw_b64: String = pem
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with("-----") && !line.is_empty())
            .collect();
        if let Ok(der) = base64::engine::general_purpose::STANDARD.decode(raw_b64) {
            let mut hasher = Sha1::new();
            hasher.update(&der);
            let fingerprint: String = hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02X}"))
                .collect::<Vec<_>>()
                .join(":");
            fingerprints.push(fingerprint);
        }
    }

    fingerprints
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

    // M9: a multi-certificate PEM bundle (e.g. Debian/Ubuntu
    // `/etc/ssl/certs/ca-certificates.crt`) must fingerprint EACH cert
    // separately so a single target cert is matched even when concatenated with
    // hundreds of others. Previously the whole bundle's base64 was concatenated
    // and hashed as one blob, which never matched any single certificate.
    #[cfg(target_os = "linux")]
    #[test]
    fn pem_bundle_fingerprints_each_certificate() {
        let cert_a = crate::RootCaPair::generate().unwrap();
        let cert_b = crate::RootCaPair::generate().unwrap();

        // Build a bundle with two unrelated certs, A then B.
        let bundle = format!("{}{}", cert_a.cert_pem(), cert_b.cert_pem());
        let bundle_fps = pem_sha1_fingerprints(&bundle);
        assert_eq!(
            bundle_fps.len(),
            2,
            "a 2-cert bundle must yield exactly 2 fingerprints"
        );

        // Each cert's standalone fingerprint must appear in the bundle's set.
        let single_a = pem_sha1_fingerprints(&cert_a.cert_pem());
        let single_b = pem_sha1_fingerprints(&cert_b.cert_pem());
        assert_eq!(single_a.len(), 1);
        assert_eq!(single_b.len(), 1);
        assert!(bundle_fps.contains(&single_a[0]));
        assert!(bundle_fps.contains(&single_b[0]));
    }
}
