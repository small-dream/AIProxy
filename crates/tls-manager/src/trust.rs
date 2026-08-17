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

/// Stable identifiers for the trust stores a removal attempt touches. The
/// frontend maps these to per-store manual removal commands when an automated
/// attempt fails (e.g. privilege denied). Keep in sync with API_SPEC.md.
pub mod trust_store {
    pub const WINDOWS_CURRENT_USER_ROOT: &str = "windows.currentUserRoot";
    pub const WINDOWS_LOCAL_MACHINE_ROOT: &str = "windows.localMachineRoot";
    pub const MACOS_USER_DOMAIN: &str = "macos.userDomain";
    pub const MACOS_SYSTEM_DOMAIN: &str = "macos.systemDomain";
    pub const MACOS_LOGIN_KEYCHAIN: &str = "macos.loginKeychain";
    pub const MACOS_SYSTEM_KEYCHAIN: &str = "macos.systemKeychain";
    pub const LINUX_ANCHORS: &str = "linux.anchors";
    pub const LINUX_CA_STORE: &str = "linux.caStore";
}

/// A single trust-store removal failure: which store rejected the removal and
/// why. Surfaced to the UI so it can show the manual command for that store.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRemovalFailure {
    pub store: String,
    pub error: String,
}

/// Outcome of removing a certificate's trust across every store the platform
/// checks. Removal is best-effort PER STORE: privilege failures are the common
/// case (Windows LocalMachine Root, macOS system domain / System keychain,
/// Linux system anchor dirs + update-ca-* all need elevation), so they are
/// reported in `failed` instead of aborting the whole removal — the UI pairs
/// each failure with the platform's manual command. A store that never held
/// the certificate counts as `succeeded` (removal is idempotent).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRemovalReport {
    pub attempted: Vec<String>,
    pub succeeded: Vec<String>,
    pub failed: Vec<TrustRemovalFailure>,
}

impl TrustRemovalReport {
    /// Record the outcome for one store. `Err` lands in `failed`; anything
    /// else (removed or simply absent) counts as `succeeded`.
    fn record(&mut self, store: &str, result: Result<(), String>) {
        self.attempted.push(store.to_string());
        match result {
            Ok(()) => self.succeeded.push(store.to_string()),
            Err(error) => self.failed.push(TrustRemovalFailure {
                store: store.to_string(),
                error,
            }),
        }
    }
}

/// Remove trust for the root CA at `cert_path` from the platform's trust
/// stores. Never fails wholesale — per-store outcomes are in the returned
/// report. The certificate file itself is not deleted here (that is
/// [`crate::CertStorage::remove_root_cert`]'s job); the file must still exist
/// when this is called because several platform commands read it to identify
/// the certificate to remove.
pub fn remove_cert_trust_on_platform(cert_path: &Path, platform: Platform) -> TrustRemovalReport {
    match platform {
        Platform::Windows => remove_cert_trust_windows(cert_path),
        Platform::Macos => remove_cert_trust_macos(cert_path),
        Platform::Linux => remove_cert_trust_linux(cert_path),
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

/// Remove the certificate from the two Windows Root stores via PowerShell.
/// CurrentUser\Root needs no elevation; LocalMachine\Root requires an admin
/// token and typically fails for a normal launch — that outcome is reported,
/// not fatal. A store that does not contain the certificate succeeds
/// (idempotent).
#[cfg(target_os = "windows")]
fn remove_cert_trust_windows(cert_path: &Path) -> TrustRemovalReport {
    use aiproxy_sys_util::CommandExt;
    use std::process::Command;

    let mut report = TrustRemovalReport::default();

    let thumbprint = match certificate_sha1_thumbprint(cert_path) {
        Ok(thumbprint) => thumbprint,
        Err(error) => {
            tracing::warn!(
                event = "windows_cert_removal_thumbprint_failed",
                path = %cert_path.to_string_lossy(),
                error,
                "windows_cert_removal_thumbprint_failed"
            );
            report.record(
                trust_store::WINDOWS_CURRENT_USER_ROOT,
                Err(format!("failed to read certificate thumbprint: {error}")),
            );
            return report;
        }
    };

    // Per-location removal. Exit code 0 with stdout "absent" (cert not in the
    // store) or "removed" both count as success; a non-zero exit surfaces the
    // stderr (e.g. access denied opening LocalMachine\Root without admin).
    let script = r#"
param([string]$Thumbprint, [string]$Location)
$ErrorActionPreference = 'Stop'
$normalized = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()

$storeLocation = [System.Enum]::Parse(
  [System.Security.Cryptography.X509Certificates.StoreLocation],
  $Location
)
$store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
  [System.Security.Cryptography.X509Certificates.StoreName]::Root,
  $storeLocation
)
try {
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $matches = $store.Certificates.Find(
    [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
    $normalized,
    $false
  )
  if ($matches.Count -eq 0) {
    'absent'
  } else {
    foreach ($cert in $matches) {
      $store.Remove($cert)
    }
    'removed'
  }
} finally {
  if ($null -ne $store) {
    $store.Close()
  }
}
"#;

    for (location, store_id) in [
        ("CurrentUser", trust_store::WINDOWS_CURRENT_USER_ROOT),
        ("LocalMachine", trust_store::WINDOWS_LOCAL_MACHINE_ROOT),
    ] {
        let result = match Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .arg(&thumbprint)
            .arg(location)
            .no_window()
            .output()
        {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                tracing::info!(
                    event = "windows_cert_removal_store_result",
                    store = store_id,
                    outcome = %stdout,
                    "windows_cert_removal_store_result"
                );
                Ok(())
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                tracing::warn!(
                    event = "windows_cert_removal_store_failed",
                    store = store_id,
                    status = ?output.status.code(),
                    stderr = %stderr,
                    "windows_cert_removal_store_failed"
                );
                Err(if stderr.is_empty() {
                    format!("powershell exited with {:?}", output.status.code())
                } else {
                    stderr
                })
            }
            Err(error) => Err(format!("failed to spawn powershell: {error}")),
        };
        report.record(store_id, result);
    }

    report
}

#[cfg(not(target_os = "windows"))]
fn remove_cert_trust_windows(_cert_path: &Path) -> TrustRemovalReport {
    TrustRemovalReport::default()
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

/// Run `security <args>` and classify the outcome for the removal report.
/// `Ok(())` means the command succeeded OR reported the target as absent
/// (idempotent removal); a real failure becomes `Err(stderr)`.
#[cfg(target_os = "macos")]
fn run_security_removal(args: &[&str]) -> Result<(), String> {
    use std::process::Command;

    let output = Command::new("/usr/bin/security")
        .args(args)
        .output()
        .map_err(|error| format!("failed to spawn security: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let lower = stderr.to_ascii_lowercase();
    // "Absent" outcomes: the trust setting / certificate was not there to
    // begin with. Removal is idempotent, so this is a success.
    if lower.contains("no such file")
        || lower.contains("not found")
        || lower.contains("could not be found")
        || lower.contains("could not find")
    {
        return Ok(());
    }
    Err(if stderr.is_empty() {
        format!("security exited with {:?}", output.status.code())
    } else {
        stderr
    })
}

/// Remove trust for the certificate on macOS:
/// - trust settings in the user domain (`remove-trusted-cert`)
/// - trust settings in the admin/system domain (`remove-trusted-cert -d`)
/// - the certificate object from the login and System keychains
///   (`delete-certificate -Z <sha1>`), which is where it lands when installed
///   through Keychain Access per our platform guide.
///
/// The system-domain/System-keychain steps need elevation and commonly fail
/// for a normal launch; those failures are reported per store.
#[cfg(target_os = "macos")]
fn remove_cert_trust_macos(cert_path: &Path) -> TrustRemovalReport {
    let mut report = TrustRemovalReport::default();

    let cert_arg = cert_path.to_string_lossy().to_string();

    report.record(
        trust_store::MACOS_USER_DOMAIN,
        run_security_removal(&["remove-trusted-cert", &cert_arg]),
    );
    report.record(
        trust_store::MACOS_SYSTEM_DOMAIN,
        run_security_removal(&["remove-trusted-cert", "-d", &cert_arg]),
    );

    // delete-certificate identifies the cert by its SHA-1 hash (-Z), which is
    // our thumbprint format (uppercase hex, no separators). The keychain
    // argument is a FILE PATH, not a display name — a bare "login"/"System"
    // would be resolved relative to cwd and fail. For the login keychain,
    // omit the argument so `security` uses the default keychain search list
    // (robust against a renamed login keychain); the System keychain needs
    // its explicit path.
    match certificate_sha1_thumbprint(cert_path) {
        Ok(thumbprint) => {
            report.record(
                trust_store::MACOS_LOGIN_KEYCHAIN,
                run_security_removal(&["delete-certificate", "-Z", &thumbprint]),
            );
            report.record(
                trust_store::MACOS_SYSTEM_KEYCHAIN,
                run_security_removal(&[
                    "delete-certificate",
                    "-Z",
                    &thumbprint,
                    "/Library/Keychains/System.keychain",
                ]),
            );
        }
        Err(error) => {
            let message = format!("failed to read certificate thumbprint: {error}");
            report.record(trust_store::MACOS_LOGIN_KEYCHAIN, Err(message.clone()));
            report.record(trust_store::MACOS_SYSTEM_KEYCHAIN, Err(message));
        }
    }

    report
}

#[cfg(not(target_os = "macos"))]
fn remove_cert_trust_macos(_cert_path: &Path) -> TrustRemovalReport {
    TrustRemovalReport::default()
}

#[cfg(target_os = "linux")]
fn is_trusted_linux(cert_path: &Path) -> bool {
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

/// Remove the certificate's anchor files from the system CA source dirs and
/// refresh the live CA store:
/// - `linux.anchors`: delete any file in the Debian/Ubuntu or Fedora/RHEL
///   anchor dir whose fingerprints match the target cert. Absent anchors
///   count as success (idempotent). Deleting files in these dirs requires
///   root, so this commonly fails and falls back to a manual command.
/// - `linux.caStore`: re-run `update-ca-certificates` / `update-ca-trust` so
///   the already-materialized `/etc/ssl/certs` entries disappear. Also needs
///   root; failure is reported per store.
#[cfg(target_os = "linux")]
fn remove_cert_trust_linux(cert_path: &Path) -> TrustRemovalReport {
    use std::process::Command;

    let mut report = TrustRemovalReport::default();

    let target_fingerprints = match std::fs::read_to_string(cert_path) {
        Ok(pem) => pem_sha1_fingerprints(&pem),
        Err(error) => {
            let message = format!("failed to read certificate: {error}");
            report.record(trust_store::LINUX_ANCHORS, Err(message.clone()));
            report.record(trust_store::LINUX_CA_STORE, Err(message));
            return report;
        }
    };

    // Anchor removal: scan both source dirs, delete matching files.
    let anchor_result = (|| -> Result<(), String> {
        for dir in [
            "/usr/local/share/ca-certificates/",
            "/etc/pki/ca-trust/source/anchors/",
        ] {
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                // A missing dir simply holds no anchors.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("failed to read {dir}: {error}")),
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    let ext_lower = ext.to_string_lossy().to_ascii_lowercase();
                    if ext_lower != "crt" && ext_lower != "pem" && ext_lower != "cer" {
                        continue;
                    }
                }
                if let Ok(other_pem) = std::fs::read_to_string(&path) {
                    let other_fingerprints = pem_sha1_fingerprints(&other_pem);
                    if other_fingerprints
                        .iter()
                        .any(|fp| target_fingerprints.contains(fp))
                    {
                        std::fs::remove_file(&path).map_err(|error| {
                            format!("failed to remove {}: {error}", path.to_string_lossy())
                        })?;
                        tracing::info!(
                            event = "linux_anchor_removed",
                            path = %path.to_string_lossy(),
                            "linux_anchor_removed"
                        );
                    }
                }
            }
        }
        Ok(())
    })();
    report.record(trust_store::LINUX_ANCHORS, anchor_result);

    // Live store refresh: pick whichever CA update tool this distro ships.
    let ca_store_result = (|| -> Result<(), String> {
        let candidates = [
            "/usr/sbin/update-ca-certificates",
            "/usr/bin/update-ca-certificates",
            "/usr/bin/update-ca-trust",
            "/usr/sbin/update-ca-trust",
        ];
        let Some(tool) = candidates
            .iter()
            .find(|path| std::path::Path::new(path).exists())
        else {
            return Err(
                "no CA store update tool found (update-ca-certificates / update-ca-trust)"
                    .to_string(),
            );
        };
        let output = Command::new(tool)
            .output()
            .map_err(|error| format!("failed to spawn {tool}: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                format!("{tool} exited with {:?}", output.status.code())
            } else {
                stderr
            })
        }
    })();
    report.record(trust_store::LINUX_CA_STORE, ca_store_result);

    report
}

#[cfg(not(target_os = "linux"))]
fn remove_cert_trust_linux(_cert_path: &Path) -> TrustRemovalReport {
    TrustRemovalReport::default()
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
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

    // The removal report's contract: every attempted store appears exactly
    // once in `attempted`, Ok outcomes (removed OR simply absent) land in
    // `succeeded`, and Err outcomes carry the store id + error into `failed`.
    // Partial failure must never abort the report — privilege failures are
    // the expected case on several stores.
    #[test]
    fn trust_removal_report_records_success_and_failure_per_store() {
        let mut report = TrustRemovalReport::default();
        report.record(trust_store::WINDOWS_CURRENT_USER_ROOT, Ok(()));
        report.record(
            trust_store::WINDOWS_LOCAL_MACHINE_ROOT,
            Err("access denied".to_string()),
        );

        assert_eq!(report.attempted.len(), 2);
        assert_eq!(
            report.succeeded,
            vec![trust_store::WINDOWS_CURRENT_USER_ROOT.to_string()]
        );
        assert_eq!(report.failed.len(), 1);
        assert_eq!(
            report.failed[0].store,
            trust_store::WINDOWS_LOCAL_MACHINE_ROOT
        );
        assert_eq!(report.failed[0].error, "access denied");
    }

    // A removal attempt where every store was absent (or already removed)
    // yields an all-success report with no failures — idempotence.
    #[test]
    fn trust_removal_report_all_success_when_stores_empty() {
        let mut report = TrustRemovalReport::default();
        report.record(trust_store::LINUX_ANCHORS, Ok(()));
        report.record(trust_store::LINUX_CA_STORE, Ok(()));
        assert!(report.failed.is_empty());
        assert_eq!(report.succeeded.len(), 2);
    }

    // The report serializes camelCase for the IPC boundary (the frontend
    // parses these exact field names).
    #[test]
    fn trust_removal_report_serializes_camel_case() {
        let report = TrustRemovalReport {
            attempted: vec![trust_store::MACOS_USER_DOMAIN.to_string()],
            succeeded: vec![],
            failed: vec![TrustRemovalFailure {
                store: trust_store::MACOS_USER_DOMAIN.to_string(),
                error: "boom".to_string(),
            }],
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"attempted\""));
        assert!(json.contains("\"succeeded\""));
        assert!(json.contains("\"failed\""));
        assert!(json.contains("\"store\""));
        assert!(json.contains("\"error\""));
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
