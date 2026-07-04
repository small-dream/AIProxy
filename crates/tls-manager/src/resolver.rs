use std::fmt;
use std::sync::{Arc, Mutex};

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
    fn resolve(&self, client_hello: rustls::server::ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let hostname = client_hello.server_name()?;

        // Fast path: check the in-memory cache first. No per-host slot is
        // needed once a cert is cached.
        {
            let mut cache = self
                .storage
                .host_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(cached) = cache.get(hostname) {
                return Some(Arc::clone(cached));
            }
        }

        // H8: cold-host single-flight. Get (or insert) a per-host mutex under
        // the short-lived inflight-table lock, then drop that table lock
        // immediately. We then acquire the per-host mutex: only the first
        // concurrent resolver for this host proceeds to sign; the rest block
        // until it finishes. This dedupes the signing-storm where N concurrent
        // handshakes for a cold hostname each independently sign (expensive
        // ECDSA keypair generation + CA sign) before racing to insert.
        //
        // Critically, the signing crypto runs while holding ONLY the per-host
        // slot mutex — never the inflight-table mutex nor the host_cache mutex
        // — so unrelated hosts and cache reads stay uncontended and we cannot
        // deadlock against a `clear_host_cache` that holds the table lock.
        let slot = {
            let mut inflight = self
                .storage
                .inflight
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            Arc::clone(
                inflight
                    .entry(hostname.to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        let _guard = slot.lock().unwrap_or_else(|e| e.into_inner());

        // Double-check the cache after acquiring the slot: another resolver may
        // have just finished signing while we waited.
        {
            let mut cache = self
                .storage
                .host_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(cached) = cache.get(hostname) {
                return Some(Arc::clone(cached));
            }
        }

        // Generate a new host certificate (only the slot-holder reaches here).
        let (cert_der, key_der) = match crate::generator::sign_host_certificate_from_data(
            &self.root_ca_sign_data,
            hostname,
        ) {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!(
                    event = "host_cert_generation_failed",
                    hostname = %hostname,
                    error = %error,
                    "host_cert_generation_failed"
                );
                return None;
            }
        };

        let signing_key = match rustls::crypto::ring::sign::any_supported_type(&key_der) {
            Ok(key) => key,
            Err(error) => {
                tracing::warn!(
                    event = "host_cert_signing_key_failed",
                    hostname = %hostname,
                    error = %error,
                    "host_cert_signing_key_failed"
                );
                return None;
            }
        };

        tracing::debug!(
            event = "host_cert_generated",
            hostname = %hostname,
            "host_cert_generated"
        );

        let certified_key = Arc::new(CertifiedKey::new(vec![cert_der], signing_key));

        // Cache it so subsequent resolvers (including the ones that waited on
        // the slot) hit the fast path.
        {
            let mut cache = self
                .storage
                .host_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.put(hostname.to_string(), Arc::clone(&certified_key));
        }

        // H8: now that this host is cached, its inflight slot (and any other
        // cached hosts' slots) are redundant — prune them so a stream of unique
        // cold hostnames cannot grow the inflight table unboundedly across the
        // process lifetime. Slots for hosts NOT yet cached are retained so any
        // in-progress waiter keeps its slot.
        self.storage.prune_inflight_if_needed();

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
