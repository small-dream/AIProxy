#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateStatus {
    pub cert_path: String,
    pub trusted: bool,
}

impl CertificateStatus {
    pub fn requires_trust_flow(&self) -> bool {
        !self.trusted
    }
}

#[cfg(test)]
mod tests {
    use super::CertificateStatus;

    #[test]
    fn reports_that_untrusted_certificates_require_action() {
        let status = CertificateStatus {
            cert_path: "./fixtures/cert.pem".to_string(),
            trusted: false,
        };

        let actual = status.requires_trust_flow();

        assert!(actual);
    }

    #[test]
    fn reports_that_trusted_certificates_do_not_require_action() {
        let status = CertificateStatus {
            cert_path: "./fixtures/cert.pem".to_string(),
            trusted: true,
        };

        let actual = status.requires_trust_flow();

        assert!(!actual);
    }
}

