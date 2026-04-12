use std::fmt;
use std::sync::Arc;

use rustls::server::ResolvesServerCert;
use rustls::sign::CertifiedKey;

use crate::generator::RootCaSignData;
use crate::storage::CertStorage;

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
            let cache = self.storage.host_cache.lock().unwrap();
            if let Some(cached) = cache.get(hostname) {
                return Some(Arc::clone(cached));
            }
        }

        // Generate a new host certificate
        let (cert_der, key_der) =
            crate::generator::sign_host_certificate_from_data(&self.root_ca_sign_data, hostname)
                .ok()?;

        let signing_key =
            rustls::crypto::ring::sign::any_supported_type(&key_der).ok()?;

        let certified_key = Arc::new(CertifiedKey::new(vec![cert_der], signing_key));

        // Cache it
        {
            let mut cache = self.storage.host_cache.lock().unwrap();
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
