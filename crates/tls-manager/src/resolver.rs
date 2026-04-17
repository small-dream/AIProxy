use std::fmt;
use std::sync::Arc;

use rustls::server::ResolvesServerCert;
use rustls::sign::CertifiedKey;

use crate::generator::RootCaSignData;
use crate::{emit_log, storage::CertStorage};

/// Dynamic certificate resolver that signs per-host certificates on demand.
pub struct DynamicCertResolver {
    root_ca_sign_data: RootCaSignData,
    storage: CertStorage,
}

impl DynamicCertResolver {
    pub fn new(root_ca_sign_data: RootCaSignData, storage: CertStorage) -> Self {
        Self {
            root_ca_sign_data,
            storage,
        }
    }
}

impl fmt::Debug for DynamicCertResolver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DynamicCertResolver").finish()
    }
}

impl ResolvesServerCert for DynamicCertResolver {
    fn resolve(
        &self,
        client_hello: rustls::server::ClientHello<'_>,
    ) -> Option<Arc<CertifiedKey>> {
        let hostname = client_hello.server_name()?;

        // Check the in-memory cache first
        {
            let cache = self.storage.host_cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(cached) = cache.get(hostname) {
                return Some(Arc::clone(cached));
            }
        }

        // Generate a new host certificate
        let (cert_der, key_der) =
            match crate::generator::sign_host_certificate_from_data(&self.root_ca_sign_data, hostname) {
                Ok(pair) => pair,
                Err(error) => {
                    emit_log("WARN", "host_cert_generation_failed", &[
                        ("hostname", hostname.to_string()),
                        ("error", error.to_string()),
                    ]);
                    return None;
                }
            };

        let signing_key = match rustls::crypto::ring::sign::any_supported_type(&key_der) {
            Ok(key) => key,
            Err(error) => {
                emit_log("WARN", "host_cert_signing_key_failed", &[
                    ("hostname", hostname.to_string()),
                    ("error", error.to_string()),
                ]);
                return None;
            }
        };

        emit_log("DEBUG", "host_cert_generated", &[("hostname", hostname.to_string())]);

        let certified_key = Arc::new(CertifiedKey::new(vec![cert_der], signing_key));

        // Cache it
        {
            let mut cache = self.storage.host_cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.insert(hostname.to_string(), Arc::clone(&certified_key));
        }

        Some(certified_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::RootCaPair;

    #[test]
    fn resolver_can_be_created_without_panic() {
        let root_ca = RootCaPair::generate().unwrap();
        let sign_data = root_ca.create_sign_data();
        let storage = CertStorage::new_in_temp_dir();
        let _resolver = DynamicCertResolver::new(sign_data, storage);
    }
}
