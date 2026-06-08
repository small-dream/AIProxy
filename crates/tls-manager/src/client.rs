use std::sync::{Arc, OnceLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::ring::default_provider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_rustls::TlsConnector;

/// A certificate verifier that accepts any server certificate.
///
/// Used by the debugging proxy for upstream connections where the proxy
/// itself is the security boundary, not the TLS connection to upstream.
#[derive(Debug)]
pub struct NoOpVerifier;

impl ServerCertVerifier for NoOpVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ED25519,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
        ]
    }
}

/// Build a dangerous `ClientConfig` with no ALPN, cached via `OnceLock`.
pub fn build_dangerous_client_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();

    Arc::clone(CONFIG.get_or_init(|| {
        let provider = default_provider();
        Arc::new(
            ClientConfig::builder_with_provider(Arc::new(provider))
                .with_safe_default_protocol_versions()
                .expect("safe default protocol versions should always be available")
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoOpVerifier))
                .with_no_client_auth(),
        )
    }))
}

/// Build a dangerous `ClientConfig` with the given ALPN protocols.
///
/// Not cached because the ALPN list may vary per call.
pub fn build_dangerous_client_config_with_alpn(alpn_protocols: Vec<Vec<u8>>) -> Arc<ClientConfig> {
    let provider = default_provider();
    let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .expect("safe default protocol versions should always be available")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoOpVerifier))
        .with_no_client_auth();

    config.alpn_protocols = alpn_protocols;
    Arc::new(config)
}

/// Convenience wrapper: build a `TlsConnector` without ALPN.
pub fn build_dangerous_tls_connector() -> TlsConnector {
    TlsConnector::from(build_dangerous_client_config())
}

/// Convenience wrapper: build a `TlsConnector` with the given ALPN protocols.
pub fn build_dangerous_tls_connector_with_alpn(alpn_protocols: Vec<Vec<u8>>) -> TlsConnector {
    TlsConnector::from(build_dangerous_client_config_with_alpn(alpn_protocols))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_verify_schemes_is_non_empty() {
        let verifier = NoOpVerifier;
        let schemes = verifier.supported_verify_schemes();
        assert!(!schemes.is_empty());
    }

    #[test]
    fn supported_verify_schemes_contains_all_eight() {
        let verifier = NoOpVerifier;
        let schemes = verifier.supported_verify_schemes();
        assert_eq!(schemes.len(), 8);
        assert!(schemes.contains(&SignatureScheme::ECDSA_NISTP256_SHA256));
        assert!(schemes.contains(&SignatureScheme::ECDSA_NISTP384_SHA384));
        assert!(schemes.contains(&SignatureScheme::ED25519));
        assert!(schemes.contains(&SignatureScheme::RSA_PSS_SHA256));
        assert!(schemes.contains(&SignatureScheme::RSA_PSS_SHA384));
        assert!(schemes.contains(&SignatureScheme::RSA_PKCS1_SHA256));
        assert!(schemes.contains(&SignatureScheme::RSA_PKCS1_SHA384));
        assert!(schemes.contains(&SignatureScheme::RSA_PKCS1_SHA512));
    }

    #[test]
    fn config_is_valid() {
        let config = build_dangerous_client_config();
        // If we got here without panic, the config built successfully.
        // Confirm it is a valid Arc<ClientConfig> (no ALPN by default).
        assert!(config.alpn_protocols.is_empty());
    }

    #[test]
    fn config_is_singleton_cached() {
        let a = build_dangerous_client_config();
        let b = build_dangerous_client_config();
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn alpn_config_sets_protocols() {
        let config =
            build_dangerous_client_config_with_alpn(vec![b"h2".to_vec(), b"http/1.1".to_vec()]);
        assert_eq!(
            config.alpn_protocols,
            vec![b"h2".to_vec(), b"http/1.1".to_vec()]
        );
    }
}
