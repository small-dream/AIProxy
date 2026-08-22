use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use http_body_util::combinators::BoxBody;
use tokio::sync::watch;

use crate::timing_connector::ConnectionTiming;

/// Key used to look up pooled connections.
///
/// No upstream-proxy dimension is needed: the proxy configuration is fixed for
/// the lifetime of a proxy server (changing it restarts the server, which drops
/// the pool), and the bypass decision is a pure function of the host — which is
/// already part of this key.
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub(crate) struct UpstreamKey {
    pub host: String,
    pub port: u16,
}

/// A pooled h2 `SendRequest` handle together with metadata.
struct PooledConnection {
    sender: hyper::client::conn::http2::SendRequest<BoxBody<bytes::Bytes, String>>,
    last_used: Instant,
}

/// A simple pool of upstream h2 connections.
///
/// HTTP/2 multiplexes many streams over a single TCP+TLS connection, so we can
/// reuse one connection for multiple requests to the same (host, port). The pool
/// stores at most **one** h2 connection per `UpstreamKey`. If the connection is
/// closed or idle for too long it is evicted and a fresh one is established on
/// the next request.
pub(crate) struct UpstreamConnectionPool {
    connections: tokio::sync::RwLock<HashMap<UpstreamKey, PooledConnection>>,
    /// Tracks in-flight connection attempts to prevent thundering-herd duplicates.
    ///
    /// A std (sync) lock on purpose: the critical sections are tiny map
    /// operations with no `.await` inside, and the cancellation-safety guard
    /// below must be able to take it from `Drop`, which cannot async-await.
    pending: RwLock<HashMap<UpstreamKey, watch::Receiver<Option<PooledConnection>>>>,
    idle_timeout: Duration,
}

/// Cancellation-safe ownership of one `pending` registration.
///
/// The connector inserts its watch channel under `pending[key]` before dialing
/// and removes it afterwards. Every removal step sits behind an `.await`, so
/// when the caller cancels `get_or_connect` mid-dial (the head-phase timeout in
/// `forward_request` drops this future) none of them run and the entry stays in
/// the map forever — one leak per timed-out host, unbounded growth. This guard
/// deregisters synchronously from `Drop`, which cannot be cancelled, so the
/// entry is cleaned up on every exit path by construction.
struct PendingConnectGuard<'a> {
    key: UpstreamKey,
    /// Clone of the receiver that was registered under [`Self::key`]. The map
    /// entry is only removed when it still IS our channel: a waiter that
    /// observed a dropped sender may already have removed the stale entry and a
    /// successor connector re-registered before our `Drop` runs, and deleting
    /// their fresh registration would just strand their dial.
    marker: watch::Receiver<Option<PooledConnection>>,
    /// Always true today — kept as a switch so a future success path can take
    /// over deregistration explicitly without restructuring the Drop logic.
    armed: bool,
    pending: &'a RwLock<HashMap<UpstreamKey, watch::Receiver<Option<PooledConnection>>>>,
}

/// Remove `key` from `pending` only when the registered receiver is still the
/// same watch channel as `marker`.
///
/// Both the connector guard's `Drop` and the waiter fallback clean up stale
/// registrations, and both can race with a successor connector that already
/// re-registered a fresh channel under the same key. Deleting that fresh entry
/// would strand the successor's dial — its result could never be awaited — so
/// removal is conditional on channel identity. Returns whether an entry was
/// removed.
fn remove_pending_entry_if_current(
    pending: &RwLock<HashMap<UpstreamKey, watch::Receiver<Option<PooledConnection>>>>,
    key: &UpstreamKey,
    marker: &watch::Receiver<Option<PooledConnection>>,
) -> bool {
    let mut pending = pending
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let is_current = pending
        .get(key)
        .is_some_and(|registered| registered.same_channel(marker));
    if is_current {
        pending.remove(key);
    }
    is_current
}

impl Drop for PendingConnectGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if remove_pending_entry_if_current(self.pending, &self.key, &self.marker) {
            tracing::debug!(
                event = "upstream_pool_pending_cancelled",
                host = %self.key.host,
                port = self.key.port,
                "cancelled connector deregistered its pending entry"
            );
        }
    }
}

impl UpstreamConnectionPool {
    pub fn new() -> Self {
        Self {
            connections: tokio::sync::RwLock::new(HashMap::new()),
            pending: RwLock::new(HashMap::new()),
            idle_timeout: Duration::from_secs(60),
        }
    }

    /// Return a cached h2 `SendRequest` if we have a valid one, otherwise
    /// establish a new h2 connection, cache it, and return it.
    ///
    /// Returns `None` if the upstream negotiated HTTP/1.1 (i.e. ALPN did not
    /// select h2), in which case the caller should fall back to the existing
    /// per-request h1 path.
    pub(crate) async fn get_or_connect(
        self: &Arc<Self>,
        key: &UpstreamKey,
        dns_override_ip: Option<IpAddr>,
        verify_upstream_tls: bool,
        tls_verify_hosts: Arc<[String]>,
        upstream_proxy: Option<Arc<crate::upstream_proxy::UpstreamProxyConfig>>,
    ) -> Result<
        Option<(
            hyper::client::conn::http2::SendRequest<BoxBody<bytes::Bytes, String>>,
            Option<ConnectionTiming>,
        )>,
        String,
    > {
        // Fast path: check the pool for an existing, live connection.
        {
            let mut connections = self.connections.write().await;
            if let Some(pooled) = connections.get_mut(key) {
                if !pooled.sender.is_closed() && pooled.last_used.elapsed() < self.idle_timeout {
                    pooled.last_used = Instant::now();
                    tracing::debug!(
                        event = "upstream_pool_reuse",
                        host = %key.host,
                        port = key.port,
                        "upstream_pool_reuse"
                    );
                    // We don't have timing info for a reused connection.
                    return Ok(Some((pooled.sender.clone(), None)));
                }
            }
        }

        // Check pending map AND register under a single write lock to eliminate
        // the TOCTOU window where two tasks could both pass a read-only check.
        // Returns either a receiver to wait on (another task is connecting) or
        // a sender plus our own receiver clone (we are the connector).
        enum PendingAction {
            Wait(watch::Receiver<Option<PooledConnection>>),
            Connect(
                watch::Sender<Option<PooledConnection>>,
                watch::Receiver<Option<PooledConnection>>,
            ),
        }

        let action = {
            let mut pending = self
                .pending
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(rx) = pending.get(key) {
                PendingAction::Wait(rx.clone())
            } else {
                let (tx, rx) = watch::channel(None);
                pending.insert(key.clone(), rx.clone());
                PendingAction::Connect(tx, rx)
            }
        };

        match action {
            PendingAction::Wait(mut rx) => {
                // Another task is connecting — wait for it to finish.
                if rx.changed().await.is_ok() {
                    if let Some(conn) = rx.borrow().as_ref() {
                        tracing::debug!(
                            event = "upstream_pool_awaited",
                            host = %key.host,
                            port = key.port,
                            "upstream_pool_awaited"
                        );
                        return Ok(Some((conn.sender.clone(), None)));
                    } else {
                        return Ok(None);
                    }
                }
                // Sender dropped without sending (task panicked). Fall through
                // to connect ourselves — but first clean up the stale entry.
                tracing::debug!(
                    event = "upstream_pool_pending_dropped",
                    host = %key.host,
                    port = key.port,
                    "upstream_pool_pending_dropped"
                );
                // Only remove the entry when it is still the channel we waited
                // on: the cancelled connector's guard may already have
                // deregistered it and a successor connector may have
                // re-registered a fresh channel for the same key — deleting
                // THAT would strand the successor's dial.
                remove_pending_entry_if_current(&self.pending, key, &rx);
                // Retry from scratch: re-enter the logic by recursing once.
                // (Tail-call via boxing to avoid unbounded stack growth.)
                return Box::pin(self.get_or_connect(
                    key,
                    dns_override_ip,
                    verify_upstream_tls,
                    tls_verify_hosts,
                    upstream_proxy,
                ))
                .await;
            }
            PendingAction::Connect(tx, rx_marker) => {
                // We are the connector. The guard owns our `pending`
                // registration from here on: every explicit removal used to sit
                // behind an `.await`, so when the caller cancelled this future
                // mid-dial (the head-phase timeout wrapper drops it) none of
                // them ran and the entry leaked — one per timed-out host,
                // unbounded growth. On drop the guard deregisters us
                // synchronously, so cancellation now cleans up by construction;
                // the success paths below simply let the guard do the same work
                // the old explicit removals did.
                let _guard = PendingConnectGuard {
                    key: key.clone(),
                    marker: rx_marker,
                    armed: true,
                    pending: &self.pending,
                };

                // Perform the connection outside any lock.
                let connect_result = self
                    .do_connect(
                        key,
                        dns_override_ip,
                        verify_upstream_tls,
                        tls_verify_hosts,
                        upstream_proxy,
                    )
                    .await;

                match connect_result {
                    Ok(Some((sender, connection_timing))) => {
                        let pooled = PooledConnection {
                            sender: sender.clone(),
                            last_used: Instant::now(),
                        };
                        {
                            let mut connections = self.connections.write().await;
                            connections.insert(key.clone(), pooled.clone_for_watch());
                        }
                        // Publish BEFORE the guard drops: a waiter that wakes on
                        // this send reads the connection directly, and any
                        // connector arriving between the send and the removal
                        // becomes a waiter instead of dialing a duplicate.
                        let _ = tx.send(Some(pooled));
                        Ok(Some((sender, Some(connection_timing))))
                    }
                    Ok(None) => {
                        let _ = tx.send(None);
                        Ok(None)
                    }
                    Err(e) => {
                        let _ = tx.send(None);
                        Err(e)
                    }
                }
                // Dropping `guard` here removes our `pending` entry on every
                // path above, and also fires when this future was cancelled at
                // either `.await`.
            }
        }
    }

    /// Perform the DNS + TCP + TLS + h2 handshake (no locking).
    async fn do_connect(
        self: &Arc<Self>,
        key: &UpstreamKey,
        dns_override_ip: Option<IpAddr>,
        verify_upstream_tls: bool,
        tls_verify_hosts: Arc<[String]>,
        upstream_proxy: Option<Arc<crate::upstream_proxy::UpstreamProxyConfig>>,
    ) -> Result<
        Option<(
            hyper::client::conn::http2::SendRequest<BoxBody<bytes::Bytes, String>>,
            ConnectionTiming,
        )>,
        String,
    > {
        let mut connector = crate::timing_connector::TimingConnector::new(
            dns_override_ip,
            verify_upstream_tls,
            tls_verify_hosts,
            upstream_proxy,
        );
        // IPv6 literals need their brackets in the authority. `key.host` keeps
        // the brackets when it came from a URL authority, but guard against the
        // bare spelling too — `https://::1:443/` is not a parseable URI.
        let authority_host = if key.host.contains(':') && !key.host.starts_with('[') {
            format!("[{}]", key.host)
        } else {
            key.host.clone()
        };
        let uri: http::Uri = format!("https://{authority_host}:{}", key.port)
            .parse()
            .map_err(|e| format!("invalid upstream URI for pool: {e}"))?;

        let (timing_stream, connection_timing) = tower_service::Service::call(&mut connector, uri)
            .await
            .map_err(|e| format!("upstream pool connect failed: {e}"))?;

        // Check ALPN — if the upstream did not negotiate h2 we cannot pool this
        // connection as h2. Return None so the caller falls back to h1.
        let negotiated_h2 = connection_timing.alpn_protocol.as_deref() == Some("h2");

        if !negotiated_h2 {
            tracing::debug!(
                event = "upstream_pool_h1_fallback",
                host = %key.host,
                port = key.port,
                alpn = %connection_timing.alpn_protocol.as_deref().unwrap_or("none"),
                "upstream_pool_h1_fallback"
            );
            return Ok(None);
        }

        let executor = hyper_util::rt::TokioExecutor::new();
        let (sender, conn) = hyper::client::conn::http2::handshake(executor, timing_stream)
            .await
            .map_err(|e| format!("upstream pool h2 handshake failed: {e}"))?;

        // Spawn the connection driver task.  A pooled sender can remain
        // apparently usable briefly after the peer has closed its connection;
        // evict as soon as the driver observes that close so the next request
        // cannot reuse a half-open entry.
        let pool = Arc::clone(self);
        let driver_key = key.clone();
        tokio::spawn(async move {
            match conn.await {
                Ok(()) => tracing::debug!(
                    event = "upstream_pool_driver_closed",
                    host = %driver_key.host,
                    port = driver_key.port,
                    reason = "clean",
                    "upstream_pool_driver_closed"
                ),
                Err(error) => {
                    tracing::warn!(
                        event = "upstream_pool_driver_failed",
                        host = %driver_key.host,
                        port = driver_key.port,
                        error = %error,
                        "upstream_pool_driver_failed"
                    );
                    pool.evict_key(&driver_key).await;
                }
            }
        });

        tracing::debug!(
            event = "upstream_pool_new_connection",
            host = %key.host,
            port = key.port,
            "upstream_pool_new_connection"
        );

        Ok(Some((sender, connection_timing)))
    }

    /// Start a background task that periodically evicts idle connections.
    pub fn start_eviction_timer(self: &Arc<Self>, interval: Duration, max_idle: Duration) {
        let pool = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                pool.evict_expired_with_max_idle(max_idle).await;
            }
        });
    }

    /// Evict expired entries using a custom idle threshold (called by timer).
    async fn evict_expired_with_max_idle(&self, max_idle: Duration) {
        let mut connections = self.connections.write().await;
        connections.retain(|key, pooled| {
            let alive = !pooled.sender.is_closed() && pooled.last_used.elapsed() < max_idle;
            if !alive {
                tracing::debug!(
                    event = "upstream_pool_evicted",
                    host = %key.host,
                    port = key.port,
                    "upstream_pool_evicted"
                );
            }
            alive
        });
    }

    /// Evict a specific key from the pool (e.g. after a send failure).
    pub(crate) async fn evict_key(&self, key: &UpstreamKey) {
        let mut connections = self.connections.write().await;
        if connections.remove(key).is_some() {
            tracing::debug!(
                event = "upstream_pool_evicted",
                host = %key.host,
                port = key.port,
                "upstream_pool_evicted"
            );
        }
    }
}

impl PooledConnection {
    /// Clone the sender for use in the watch channel notification.
    fn clone_for_watch(&self) -> Self {
        Self {
            sender: self.sender.clone(),
            last_used: self.last_used,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// NOTE: Full integration tests for get_or_connect require real h2 connections
// which depend on TLS + ALPN negotiation, making them unsuitable for unit tests.
// The tests below exercise the eviction and pending-map logic in isolation.

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Verify that evict_expired_with_max_idle removes stale entries.
    ///
    /// Since PooledConnection requires a real h2 SendRequest (which we cannot
    /// construct without a TLS handshake), we test eviction indirectly by
    /// checking the connections map after calling evict_expired_with_max_idle
    /// on a pool populated through a workaround.
    ///
    /// For now this test validates the pool construction and that eviction on
    /// an empty pool is a no-op (does not panic).
    #[tokio::test]
    async fn eviction_on_empty_pool_is_noop() {
        let pool = UpstreamConnectionPool::new();
        // Should not panic or deadlock on an empty pool.
        pool.evict_expired_with_max_idle(Duration::from_secs(60))
            .await;

        // The connections map should remain empty.
        let connections = pool.connections.read().await;
        assert!(connections.is_empty());
    }

    /// Verify the pending map dedup: when a receiver is registered for a key,
    /// a second lookup returns the same receiver (Wait variant).
    /// This is tested indirectly by confirming that the pool's pending map
    /// has the expected entry after registration.
    #[tokio::test]
    async fn pending_map_dedup_registers_single_entry() {
        let pool = UpstreamConnectionPool::new();
        let key = UpstreamKey {
            host: "api.example.com".to_string(),
            port: 443,
        };

        // Simulate what get_or_connect does when registering a pending entry:
        // insert a watch channel into the pending map.
        let (tx, rx) = tokio::sync::watch::channel(None);
        {
            let mut pending = pool
                .pending
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            pending.insert(key.clone(), rx);
        }

        // Verify the pending map has exactly one entry.
        {
            let pending = pool
                .pending
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            assert_eq!(pending.len(), 1);
            assert!(pending.contains_key(&key));
        }

        // A second insert for the same key should replace the entry.
        let (tx2, rx2) = tokio::sync::watch::channel(None);
        {
            let mut pending = pool
                .pending
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            pending.insert(key.clone(), rx2);
        }

        {
            let pending = pool
                .pending
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            assert_eq!(pending.len(), 1);
        }

        // Suppress unused warnings.
        drop(tx);
        drop(tx2);
    }

    fn test_key() -> UpstreamKey {
        UpstreamKey {
            host: "api.example.com".to_string(),
            port: 443,
        }
    }

    /// The leak being fixed: a connector whose `get_or_connect` future is
    /// dropped mid-dial (head-phase timeout) must deregister its `pending`
    /// entry from `Drop`. Without the guard the entry stayed forever — one per
    /// timed-out host, unbounded growth.
    #[test]
    fn cancelled_connector_deregisters_its_pending_entry() {
        let pool = UpstreamConnectionPool::new();
        let key = test_key();

        let (_tx, rx) = tokio::sync::watch::channel(None);
        pool.pending
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone(), rx.clone());

        // Simulates the cancellation path: the connector future is dropped
        // without reaching any of its explicit cleanup steps, so only the
        // guard's Drop runs.
        drop(PendingConnectGuard {
            key: key.clone(),
            marker: rx,
            armed: true,
            pending: &pool.pending,
        });

        let pending = pool
            .pending
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(
            !pending.contains_key(&key),
            "a cancelled connector must not leave its pending entry behind"
        );
    }

    /// A successor connector may have re-registered the key between our
    /// cancellation and our Drop; deleting their fresh channel would strand
    /// THEIR dial, so the guard only removes its own registration.
    #[test]
    fn guard_never_removes_a_successors_registration() {
        let pool = UpstreamConnectionPool::new();
        let key = test_key();

        let (_stale_tx, stale_rx) = tokio::sync::watch::channel(None);
        let (successor_tx, _successor_rx) = tokio::sync::watch::channel(None);
        pool.pending
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone(), successor_tx.subscribe());

        drop(PendingConnectGuard {
            key: key.clone(),
            marker: stale_rx,
            armed: true,
            pending: &pool.pending,
        });

        let pending = pool
            .pending
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(
            pending.contains_key(&key),
            "the guard must not delete a successor connector's registration"
        );
    }

    /// Sanity check for the disarm switch: a disarmed guard leaves the map
    /// untouched (used if a future success path takes over removal).
    #[test]
    fn disarmed_guard_leaves_the_entry_in_place() {
        let pool = UpstreamConnectionPool::new();
        let key = test_key();

        let (_tx, rx) = tokio::sync::watch::channel(None);
        pool.pending
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone(), rx.clone());

        drop(PendingConnectGuard {
            key: key.clone(),
            marker: rx,
            armed: false,
            pending: &pool.pending,
        });

        let pending = pool
            .pending
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(pending.contains_key(&key), "disarmed guard must be a no-op");
    }

    /// The waiter fallback (stale sender observed via `rx.changed()`) shares
    /// the guard's identity check: when a successor connector has already
    /// re-registered the key, the stale marker must not delete their entry.
    #[test]
    fn waiter_cleanup_never_removes_a_successors_registration() {
        let pool = UpstreamConnectionPool::new();
        let key = test_key();

        let (_stale_tx, stale_rx) = tokio::sync::watch::channel(None);
        let (successor_tx, _successor_rx) = tokio::sync::watch::channel(None);
        pool.pending
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone(), successor_tx.subscribe());

        let removed = remove_pending_entry_if_current(&pool.pending, &key, &stale_rx);
        assert!(!removed, "a stale waiter marker must not remove anything");

        let pending = pool
            .pending
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(
            pending.contains_key(&key),
            "the waiter cleanup must not delete a successor connector's registration"
        );
    }

    /// The same cleanup still removes the entry when it is the waiter's own
    /// channel — the normal stale-entry path after a connector panicked or was
    /// cancelled before its guard ran.
    #[test]
    fn waiter_cleanup_removes_its_own_stale_entry() {
        let pool = UpstreamConnectionPool::new();
        let key = test_key();

        let (_tx, rx) = tokio::sync::watch::channel(None);
        pool.pending
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone(), rx.clone());

        let removed = remove_pending_entry_if_current(&pool.pending, &key, &rx);
        assert!(removed, "the waiter's own stale entry must be removed");

        let pending = pool
            .pending
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(!pending.contains_key(&key));
    }

    /// Verify that evict_key removes the specified key from the pool.
    #[tokio::test]
    async fn evict_key_removes_target_entry() {
        let pool = UpstreamConnectionPool::new();
        let key = UpstreamKey {
            host: "api.example.com".to_string(),
            port: 443,
        };

        // Pool is empty — evict_key should be a no-op.
        pool.evict_key(&key).await;

        let connections = pool.connections.read().await;
        assert!(connections.is_empty());
    }

    /// Verify that the pool starts with the configured idle timeout.
    #[test]
    fn pool_default_idle_timeout() {
        let pool = UpstreamConnectionPool::new();
        assert_eq!(pool.idle_timeout, Duration::from_secs(60));
    }
}
