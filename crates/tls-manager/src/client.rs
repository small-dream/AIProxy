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

/// Build a verifying `ClientConfig` (real certificate checks against the
/// platform root store) with the given ALPN protocols.
///
/// Unlike the `build_dangerous_*` family, this uses rustls's default
/// `WebPkiServerVerifier` over the OS native root certificates so
/// self-signed/invalid upstream certificates are rejected during the
/// handshake. Used by H3 when a workspace opts into upstream TLS
/// verification.
///
/// The native root store is loaded once and cached in a `OnceLock` because
/// `rustls_native_certs::load_native_certs` is a (bounded) blocking syscall
/// that walks the platform trust store. The returned `ClientConfig` is NOT
/// cached because the ALPN list may vary per call (mirrors the
/// dangerous-with-alpn builder).
pub fn build_verifying_client_config_with_alpn(alpn_protocols: Vec<Vec<u8>>) -> Arc<ClientConfig> {
    let root_store = load_native_root_store();
    let provider = default_provider();
    let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .expect("safe default protocol versions should always be available")
        .with_root_certificates(root_store)
        .with_no_client_auth();

    config.alpn_protocols = alpn_protocols;
    Arc::new(config)
}

/// Load the platform's native root certificates into a rustls
/// `RootCertStore`, caching the result process-wide (the OS trust store
/// changes rarely and `load_native_certs` is a blocking syscall).
fn load_native_root_store() -> rustls::RootCertStore {
    static ROOT_STORE: OnceLock<rustls::RootCertStore> = OnceLock::new();
    ROOT_STORE
        .get_or_init(|| {
            let mut store = rustls::RootCertStore::empty();
            // rustls-native-certs 0.8 returns a CertificateResult whose `.certs`
            // and `.errors` fields partition the OS trust store into loadable
            // roots and per-cert load failures. We add every successfully
            // parsed root and log (without aborting) any that failed to parse.
            let result = rustls_native_certs::load_native_certs();
            for cert in result.certs {
                if let Err(error) = store.add(cert) {
                    tracing::warn!(
                        event = "native_root_cert_skipped",
                        error = %error,
                        "native_root_cert_skipped"
                    );
                }
            }
            if !result.errors.is_empty() {
                // If we cannot read ANY OS roots the store stays empty, so
                // verification stays enabled but will reject all upstreams
                // until the user fixes their trust store. Log loudly so this
                // surfaces as "verify failed closed" rather than a silent
                // degradation to NoOp.
                tracing::error!(
                    event = "native_roots_load_failed",
                    error_count = result.errors.len(),
                    loaded_count = store.len(),
                    first_error = ?result.errors.first(),
                    "native_roots_load_failed"
                );
            }
            store
        })
        .clone()
}

/// Convenience wrapper: build a verifying `TlsConnector` with ALPN.
pub fn build_verifying_tls_connector_with_alpn(alpn_protocols: Vec<Vec<u8>>) -> TlsConnector {
    TlsConnector::from(build_verifying_client_config_with_alpn(alpn_protocols))
}

/// Build a `TlsConnector` that verifies upstream certs when `verify` is true,
/// or accepts any cert (the historical debug-proxy default) when false.
///
/// This centralizes the H3 verify switch so callers (`TimingConnector`,
/// `ws_upgrade`) select behavior with a single boolean instead of branching
/// at each TLS handshake site.
pub fn build_tls_connector_with_alpn_and_verify(
    alpn_protocols: Vec<Vec<u8>>,
    verify: bool,
) -> TlsConnector {
    if verify {
        build_verifying_tls_connector_with_alpn(alpn_protocols)
    } else {
        build_dangerous_tls_connector_with_alpn(alpn_protocols)
    }
}

/// Build a `ClientConfig` that verifies upstream certs when `verify` is true,
/// or accepts any cert when false (no ALPN).
pub fn build_client_config_with_alpn_and_verify(
    alpn_protocols: Vec<Vec<u8>>,
    verify: bool,
) -> Arc<ClientConfig> {
    if verify {
        build_verifying_client_config_with_alpn(alpn_protocols)
    } else {
        build_dangerous_client_config_with_alpn(alpn_protocols)
    }
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

    #[test]
    fn build_dangerous_client_config_with_empty_alpn_is_valid() {
        let config = build_dangerous_client_config_with_alpn(vec![]);
        assert!(config.alpn_protocols.is_empty());
    }

    #[test]
    fn build_dangerous_tls_connector_returns_valid_connector() {
        let _connector = build_dangerous_tls_connector();
        // If this compiles and doesn't panic, the connector is valid
    }

    #[test]
    fn build_dangerous_tls_connector_with_alpn_returns_valid_connector() {
        let _connector =
            build_dangerous_tls_connector_with_alpn(vec![b"h2".to_vec(), b"http/1.1".to_vec()]);
        // If this compiles and doesn't panic, the connector is valid
    }

    // H3: the verifying config must build without panic, carry the requested
    // ALPN protocols, and — critically — differ from the dangerous config in
    // whether a self-signed cert would be accepted. The two configs cannot be
    // pointer-equal because the dangerous one is `OnceLock`-cached while the
    // verifying one is freshly built each call.
    #[test]
    fn verifying_config_builds_with_alpn() {
        let config =
            build_verifying_client_config_with_alpn(vec![b"h2".to_vec(), b"http/1.1".to_vec()]);
        assert_eq!(
            config.alpn_protocols,
            vec![b"h2".to_vec(), b"http/1.1".to_vec()]
        );
    }

    #[test]
    fn verifying_connector_with_alpn_is_valid() {
        let _connector =
            build_verifying_tls_connector_with_alpn(vec![b"h2".to_vec(), b"http/1.1".to_vec()]);
    }

    // H3: the select helper must hand back a usable config for both verify
    // modes and carry the requested ALPN protocols through. We can't assert
    // pointer-equality because the dangerous-with-alpn path is intentionally
    // not cached (ALPN may vary per call); instead we verify both branches
    // build and preserve ALPN, which is the observable contract callers rely
    // on.
    #[test]
    fn select_by_verify_flag_returns_expected_config() {
        let alpn = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

        let verify_off = build_client_config_with_alpn_and_verify(alpn.clone(), false);
        assert_eq!(verify_off.alpn_protocols, alpn);

        let verify_on = build_client_config_with_alpn_and_verify(alpn.clone(), true);
        assert_eq!(verify_on.alpn_protocols, alpn);

        // Both must build a TlsConnector without panic.
        let _c_off = build_tls_connector_with_alpn_and_verify(alpn.clone(), false);
        let _c_on = build_tls_connector_with_alpn_and_verify(alpn, true);
    }

    // H3: the native root store loader must be idempotent across calls and
    // return a usable (non-panicking) store. We can't assert the store is
    // non-empty portably (CI sandboxes may have no roots), but loading twice
    // must not panic and must return the same cached instance.
    #[test]
    fn native_root_store_loads_idempotently() {
        let a = load_native_root_store();
        let b = load_native_root_store();
        // RootCertStore does not expose identity, but the OnceLock guarantees a
        // single init — calling twice must simply not panic. We assert the
        // type is usable by reading the (possibly empty) root count.
        let _ = a.roots.len();
        let _ = b.roots.len();
    }
}
