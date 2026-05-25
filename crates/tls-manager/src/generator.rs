use std::sync::Arc;

use chrono::Datelike;
use rcgen::{
    BasicConstraints, Certificate, CertificateParams, DnType, Ia5String, IsCa, KeyPair,
    KeyUsagePurpose, SanType,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};

use crate::storage::CertStorage;
use crate::{emit_log, TlsManagerError, DYNAMIC_CERT_VALIDITY_YEARS, ROOT_CA_VALIDITY_YEARS};

const ROOT_CA_CN: &str = "AIProxy Root CA";

/// Holds the root CA certificate and private key, with pre-serialized forms for reuse.
pub struct RootCaPair {
    cert_params: CertificateParams,
    key_pair: Arc<KeyPair>,
    issuer_cert: Arc<Certificate>,
    cert_pem: String,
    key_pem: String,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
    fingerprint: String,
}

impl RootCaPair {
    /// Generate a fresh self-signed root CA.
    pub fn generate() -> Result<Self, TlsManagerError> {
        let mut params = CertificateParams::default();
        params
            .distinguished_name
            .push(DnType::CommonName, ROOT_CA_CN);
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages.push(KeyUsagePurpose::KeyCertSign);
        params.key_usages.push(KeyUsagePurpose::CrlSign);

        let now = chrono::Utc::now();
        params.not_before = rcgen::date_time_ymd(now.year(), now.month() as u8, now.day() as u8);
        params.not_after = rcgen::date_time_ymd(
            now.year() + ROOT_CA_VALIDITY_YEARS as i32,
            now.month() as u8,
            now.day() as u8,
        );

        let key_pair = Arc::new(KeyPair::generate()?);
        let cert = params.clone().self_signed(&key_pair)?;
        let cert_pem = cert.pem();
        let key_pem = key_pair.serialize_pem();
        let cert_der = cert.der().to_vec();
        let key_der = key_pair.serialize_der();
        let issuer_cert = Arc::new(cert);

        let fingerprint = compute_fingerprint(&cert_der);

        emit_log(
            "INFO",
            "root_ca_generated",
            &[("fingerprint", fingerprint.clone())],
        );

        Ok(Self {
            cert_params: params,
            key_pair,
            issuer_cert,
            cert_pem,
            key_pem,
            cert_der,
            key_der,
            fingerprint,
        })
    }

    /// Load from existing PEM strings on disk.
    pub fn load_from_pem(cert_pem: &str, key_pem: &str) -> Result<Self, TlsManagerError> {
        let key_pair = Arc::new(KeyPair::from_pem(key_pem)?);
        let params = CertificateParams::from_ca_cert_pem(cert_pem)?;
        let cert = params.clone().self_signed(&key_pair)?;
        let cert_der = cert.der().to_vec();
        let key_der = key_pair.serialize_der();
        let fingerprint = compute_fingerprint(&cert_der);
        let issuer_cert = Arc::new(cert);

        Ok(Self {
            cert_params: params,
            key_pair,
            issuer_cert,
            cert_pem: cert_pem.to_string(),
            key_pem: key_pem.to_string(),
            cert_der,
            key_der,
            fingerprint,
        })
    }

    pub fn cert_pem(&self) -> &str {
        &self.cert_pem
    }

    pub fn key_pem(&self) -> &str {
        &self.key_pem
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// Build the cert_der and key_der into rustls types.
    pub fn rustls_certified_key(&self) -> Result<Arc<rustls::sign::CertifiedKey>, TlsManagerError> {
        let cert = CertificateDer::from(self.cert_der.clone());
        let key = PrivateKeyDer::from(PrivatePkcs8KeyDer::from(self.key_der.clone()));
        let signing_key = rustls::crypto::ring::sign::any_supported_type(&key)
            .map_err(|e| TlsManagerError::GenerationFailed(format!("signing key error: {e}")))?;
        Ok(Arc::new(rustls::sign::CertifiedKey::new(
            vec![cert],
            signing_key,
        )))
    }

    /// Create a `rustls::ServerConfig` that dynamically signs certs for any hostname.
    pub fn create_server_config(
        &self,
        storage: &CertStorage,
        alpn_protocols: Option<Vec<Vec<u8>>>,
    ) -> Result<Arc<rustls::ServerConfig>, TlsManagerError> {
        use crate::resolver::DynamicCertResolver;

        let sign_data = self.create_sign_data();
        let resolver = DynamicCertResolver::new(sign_data, storage.clone());

        let mut config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(resolver));
        if let Some(protocols) = alpn_protocols {
            config.alpn_protocols = protocols;
        }

        Ok(Arc::new(config))
    }

    /// Create the data needed for signing operations (shares the Arc<KeyPair>).
    pub fn create_sign_data(&self) -> RootCaSignData {
        RootCaSignData {
            cert_params: self.cert_params.clone(),
            key_pair: Arc::clone(&self.key_pair),
            issuer_cert: Arc::clone(&self.issuer_cert),
        }
    }

    /// The key pair used for signing host certificates.
    pub fn key_pair(&self) -> &KeyPair {
        &self.key_pair
    }

    /// The certificate params (for signing child certs).
    pub fn cert_params(&self) -> &CertificateParams {
        &self.cert_params
    }

    /// The raw DER bytes of the root certificate.
    pub fn cert_der(&self) -> &[u8] {
        &self.cert_der
    }

    /// The raw DER bytes of the root private key.
    pub fn key_der(&self) -> &[u8] {
        &self.key_der
    }
}

/// Data needed for signing host certificates (shared via Arc).
pub struct RootCaSignData {
    pub cert_params: CertificateParams,
    pub key_pair: Arc<KeyPair>,
    pub issuer_cert: Arc<Certificate>,
}

/// Build a SAN DNS name, converting the hostname to Ia5String.
fn dns_san(hostname: &str) -> Result<SanType, TlsManagerError> {
    let ia5 = Ia5String::try_from(hostname.to_string())
        .map_err(|e| TlsManagerError::GenerationFailed(format!("invalid hostname for SAN: {e}")))?;
    Ok(SanType::DnsName(ia5))
}

/// Sign a leaf certificate for a specific hostname using the root CA.
pub fn sign_host_certificate(
    root_ca: &RootCaPair,
    hostname: &str,
) -> Result<(CertificateDer<'static>, PrivateKeyDer<'static>), TlsManagerError> {
    let mut params = CertificateParams::default();
    params.distinguished_name.push(DnType::CommonName, hostname);
    params.subject_alt_names.push(dns_san(hostname)?);
    params.key_usages.push(KeyUsagePurpose::DigitalSignature);
    params.key_usages.push(KeyUsagePurpose::KeyEncipherment);
    params
        .extended_key_usages
        .push(rcgen::ExtendedKeyUsagePurpose::ServerAuth);

    let now = chrono::Utc::now();
    params.not_before = rcgen::date_time_ymd(now.year(), now.month() as u8, now.day() as u8);
    params.not_after = rcgen::date_time_ymd(
        now.year() + DYNAMIC_CERT_VALIDITY_YEARS as i32,
        now.month() as u8,
        now.day() as u8,
    );

    let host_key_pair = KeyPair::generate()?;
    let cert = params.signed_by(&host_key_pair, &root_ca.issuer_cert, &root_ca.key_pair)?;

    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivateKeyDer::from(PrivatePkcs8KeyDer::from(host_key_pair.serialize_der()));

    Ok((cert_der, key_der))
}

/// Sign a leaf certificate using the sign data (for resolver use).
pub fn sign_host_certificate_from_data(
    sign_data: &RootCaSignData,
    hostname: &str,
) -> Result<(CertificateDer<'static>, PrivateKeyDer<'static>), TlsManagerError> {
    let mut params = CertificateParams::default();
    params.distinguished_name.push(DnType::CommonName, hostname);
    params.subject_alt_names.push(dns_san(hostname)?);
    params.key_usages.push(KeyUsagePurpose::DigitalSignature);
    params.key_usages.push(KeyUsagePurpose::KeyEncipherment);
    params
        .extended_key_usages
        .push(rcgen::ExtendedKeyUsagePurpose::ServerAuth);

    let now = chrono::Utc::now();
    params.not_before = rcgen::date_time_ymd(now.year(), now.month() as u8, now.day() as u8);
    params.not_after = rcgen::date_time_ymd(
        now.year() + DYNAMIC_CERT_VALIDITY_YEARS as i32,
        now.month() as u8,
        now.day() as u8,
    );

    let host_key_pair = KeyPair::generate()?;
    let cert = params.signed_by(&host_key_pair, &sign_data.issuer_cert, &sign_data.key_pair)?;

    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivateKeyDer::from(PrivatePkcs8KeyDer::from(host_key_pair.serialize_der()));

    Ok((cert_der, key_der))
}

/// Compute SHA-256 fingerprint as colon-separated hex.
fn compute_fingerprint(der: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(der);
    let result = hasher.finalize();
    result
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_root_ca_with_expected_subject() {
        let root_ca = RootCaPair::generate().unwrap();
        let cn = root_ca
            .cert_params
            .distinguished_name
            .iter()
            .find(|dn| *dn.0 == DnType::CommonName);
        assert!(cn.is_some());
        let cn_value = &cn.unwrap().1;
        match cn_value {
            rcgen::DnValue::Utf8String(s) => assert_eq!(s, ROOT_CA_CN),
            rcgen::DnValue::PrintableString(s) => assert_eq!(s.to_string(), ROOT_CA_CN),
            other => panic!("unexpected DnValue type: {other:?}"),
        }
    }

    #[test]
    fn root_ca_pem_is_valid_x509() {
        let root_ca = RootCaPair::generate().unwrap();
        let parsed = x509_parser::parse_x509_certificate(root_ca.cert_der());
        assert!(parsed.is_ok(), "DER should parse as valid X.509");
    }

    #[test]
    fn signs_a_host_certificate_with_san() {
        let root_ca = RootCaPair::generate().unwrap();
        let (cert_der, _key_der) = sign_host_certificate(&root_ca, "example.com").unwrap();
        let parsed = x509_parser::parse_x509_certificate(&cert_der);
        assert!(parsed.is_ok());
        let cert = parsed.unwrap().1;
        let san = cert
            .extensions()
            .iter()
            .find(|ext| ext.oid == x509_parser::oid_registry::OID_X509_EXT_SUBJECT_ALT_NAME);
        assert!(san.is_some(), "host cert should have SAN extension");
    }

    #[test]
    fn computes_a_stable_sha256_fingerprint() {
        let root_ca = RootCaPair::generate().unwrap();
        let fp = root_ca.fingerprint();
        // SHA-256 produces 32 bytes = 64 hex chars + 31 colons = 95 chars
        assert_eq!(fp.len(), 95);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit() || c == ':'));
    }

    #[test]
    fn creates_a_valid_rustls_server_config() {
        let root_ca = RootCaPair::generate().unwrap();
        let storage = CertStorage::new_in_temp_dir();
        let config = root_ca.create_server_config(&storage, None);
        assert!(config.is_ok(), "should produce a valid ServerConfig");
    }
}
