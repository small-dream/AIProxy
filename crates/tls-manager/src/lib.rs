pub mod generator;
pub mod resolver;
pub mod storage;
pub mod trust;

pub use generator::RootCaPair;
pub use storage::CertStorage;
pub use trust::{detect_platform, is_cert_trusted_on_platform, Platform};

fn emit_log(level: &str, event: &str, fields: &[(&str, String)]) {
    let fields_ref: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
    match level {
        "ERROR" => tracing::error!(event, fields = ?fields_ref),
        "WARN" => tracing::warn!(event, fields = ?fields_ref),
        "INFO" => tracing::info!(event, fields = ?fields_ref),
        _ => tracing::debug!(event, fields = ?fields_ref),
    }
}

use serde::Serialize;

const ROOT_CA_VALIDITY_YEARS: u32 = 10;
const DYNAMIC_CERT_VALIDITY_YEARS: u32 = 1;

/// Status of the root CA certificate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateStatus {
    pub cert_path: Option<String>,
    pub fingerprint: Option<String>,
    pub trusted: bool,
    pub platform: String,
}

impl CertificateStatus {
    pub fn requires_trust_flow(&self) -> bool {
        !self.trusted
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TlsManagerError {
    #[error("certificate generation failed: {0}")]
    GenerationFailed(String),
    #[error("certificate storage error: {0}")]
    StorageError(String),
    #[error("certificate not found")]
    NotFound,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl From<rcgen::Error> for TlsManagerError {
    fn from(e: rcgen::Error) -> Self {
        TlsManagerError::GenerationFailed(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_that_untrusted_certificates_require_action() {
        let status = CertificateStatus {
            cert_path: Some("./fixtures/cert.pem".to_string()),
            fingerprint: Some("AA:BB".to_string()),
            trusted: false,
            platform: "windows".to_string(),
        };
        assert!(status.requires_trust_flow());
    }

    #[test]
    fn reports_that_trusted_certificates_do_not_require_action() {
        let status = CertificateStatus {
            cert_path: Some("./fixtures/cert.pem".to_string()),
            fingerprint: Some("AA:BB".to_string()),
            trusted: true,
            platform: "windows".to_string(),
        };
        assert!(!status.requires_trust_flow());
    }
}
