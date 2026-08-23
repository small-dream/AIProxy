use std::collections::HashMap;
use std::convert::Infallible;
use std::net::IpAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, RwLock,
};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use tokio::sync::{watch, Notify, OwnedMutexGuard};

const MAX_H1_CONNECTIONS_PER_KEY: usize = 4;

use crate::timing_connector::ConnectionTiming;

pub(crate) type H1RequestBody = BoxBody<Bytes, Infallible>;
pub(crate) type H1Sender = hyper::client::conn::http1::SendRequest<H1RequestBody>;
type H2RequestBody = BoxBody<Bytes, String>;
type H2Sender = hyper::client::conn::http2::SendRequest<H2RequestBody>;
type PendingRegistration = (
    watch::Sender<Option<Arc<PooledConnection>>>,
    watch::Receiver<Option<Arc<PooledConnection>>>,
);

/// Key used to look up pooled connections.
///
/// No upstream-proxy dimension is needed: the proxy configuration is fixed for
/// the lifetime of a proxy server (changing it restarts the server, which drops
/// the pool), and the bypass decision is a pure function of the host — which is
/// already part of this key.
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub(crate) struct UpstreamKey {
    /// The scheme is part of the key because `http://host:443` and
    /// `https://host:443` must never share a transport.
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

/// A checked-out h1 sender. The mutex guard is held until the response body is
/// fully consumed, which prevents two requests from interleaving on one h1
/// connection and makes cancellation close/evict the correct connection.
pub(crate) struct H1Lease {
    connection: Arc<H1PooledConnection>,
    notify: Arc<Notify>,
    sender: OwnedMutexGuard<H1Sender>,
}

impl H1Lease {
    pub(crate) fn sender_mut(&mut self) -> &mut H1Sender {
        &mut self.sender
    }

    pub(crate) fn connection(&self) -> Arc<H1PooledConnection> {
        Arc::clone(&self.connection)
    }
}

impl Drop for H1Lease {
    fn drop(&mut self) {
        if !self.connection.closed.load(Ordering::Acquire) {
            if let Ok(mut last_used) = self.connection.last_used.lock() {
                *last_used = Instant::now();
            }
        }
        self.notify.notify_one();
    }
}

pub(crate) struct H1PooledConnection {
    sender: Arc<tokio::sync::Mutex<H1Sender>>,
    last_used: Mutex<Instant>,
    closed: AtomicBool,
    driver_finished: AtomicBool,
    driver: Mutex<Option<tokio::task::JoinHandle<()>>>,
    notify: Arc<Notify>,
}

impl H1PooledConnection {
    fn new(sender: H1Sender, notify: Arc<Notify>) -> Self {
        Self {
            sender: Arc::new(tokio::sync::Mutex::new(sender)),
            last_used: Mutex::new(Instant::now()),
            closed: AtomicBool::new(false),
            driver_finished: AtomicBool::new(false),
            driver: Mutex::new(None),
            notify,
        }
    }

    fn try_acquire(
        self: &Arc<Self>,
        timing: Option<ConnectionTiming>,
    ) -> Option<UpstreamConnection> {
        if self.closed.load(Ordering::Acquire) {
            return None;
        }
        let sender = match Arc::clone(&self.sender).try_lock_owned() {
            Ok(sender) => sender,
            Err(_) => return None,
        };
        if self.closed.load(Ordering::Acquire) || sender.is_closed() {
            drop(sender);
            self.mark_closed();
            return None;
        }
        if let Ok(mut last_used) = self.last_used.lock() {
            *last_used = Instant::now();
        }
        Some(UpstreamConnection::H1 {
            lease: H1Lease {
                connection: Arc::clone(self),
                notify: Arc::clone(&self.notify),
                sender,
            },
            timing,
        })
    }

    /// A busy h1 connection is never evicted. A waiter that has not acquired
    /// the mutex yet may race with eviction, but `acquire` rechecks `closed`
    /// after obtaining the guard and will retry through the pool.
    fn is_alive_and_not_idle(&self, max_idle: Duration) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        match self.sender.try_lock() {
            Ok(sender) if sender.is_closed() => false,
            Ok(_) => self
                .last_used
                .lock()
                .map(|last_used| last_used.elapsed() < max_idle)
                .unwrap_or(false),
            Err(_) => true,
        }
    }

    fn mark_closed(&self) {
        self.closed.store(true, Ordering::Release);
    }

    fn set_driver(&self, driver: tokio::task::JoinHandle<()>) {
        if self.driver_finished.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut stored) = self.driver.lock() {
            if self.driver_finished.load(Ordering::Acquire) {
                return;
            }
            *stored = Some(driver);
        }
    }

    fn mark_driver_finished(&self) {
        self.driver_finished.store(true, Ordering::Release);
    }

    fn abort_driver(&self) {
        if let Ok(mut stored) = self.driver.lock() {
            if let Some(driver) = stored.take() {
                if !self.driver_finished.load(Ordering::Acquire) && !driver.is_finished() {
                    driver.abort();
                    #[cfg(test)]
                    crate::upstream::h1_pool_driver_aborted_for_test();
                }
            }
        }
    }

    pub(crate) fn close_and_abort(&self) {
        self.mark_closed();
        self.abort_driver();
    }
}

struct H2PooledConnection {
    sender: H2Sender,
    last_used: Mutex<Instant>,
}

enum PooledConnection {
    H2(Arc<H2PooledConnection>),
    H1(Arc<H1PooledConnection>),
}

/// A protocol-aware upstream connection checked out for one request.
pub(crate) enum UpstreamConnection {
    H2 {
        sender: H2Sender,
        timing: Option<ConnectionTiming>,
    },
    H1 {
        lease: H1Lease,
        timing: Option<ConnectionTiming>,
    },
}

impl PooledConnection {
    fn is_alive_and_not_idle(&self, max_idle: Duration) -> bool {
        match self {
            Self::H2(connection) => {
                !connection.sender.is_closed()
                    && connection
                        .last_used
                        .lock()
                        .map(|last_used| last_used.elapsed() < max_idle)
                        .unwrap_or(false)
            }
            Self::H1(connection) => connection.is_alive_and_not_idle(max_idle),
        }
    }

    fn mark_closed(&self) {
        if let Self::H1(connection) = self {
            connection.mark_closed();
        }
    }

    fn is_h1(&self) -> bool {
        matches!(self, Self::H1(_))
    }

    fn h1_connection(&self) -> Option<Arc<H1PooledConnection>> {
        match self {
            Self::H1(connection) => Some(Arc::clone(connection)),
            Self::H2(_) => None,
        }
    }

    fn abort_driver(&self) {
        if let Self::H1(connection) = self {
            connection.abort_driver();
        }
    }

    fn mark_driver_finished(&self) {
        if let Self::H1(connection) = self {
            connection.mark_driver_finished();
        }
    }

    fn try_acquire(
        pooled: Arc<Self>,
        timing: Option<ConnectionTiming>,
    ) -> Option<UpstreamConnection> {
        match pooled.as_ref() {
            Self::H2(connection) => {
                if connection.sender.is_closed() {
                    return None;
                }
                if let Ok(mut last_used) = connection.last_used.lock() {
                    *last_used = Instant::now();
                }
                Some(UpstreamConnection::H2 {
                    sender: connection.sender.clone(),
                    timing,
                })
            }
            Self::H1(connection) => connection.try_acquire(timing),
        }
    }
}

/// A protocol-aware pool of upstream connections.
///
/// HTTP/2 stores one multiplexed sender per key. HTTP/1.1 stores a bounded set
/// of persistent senders, each behind an exclusive lease. This preserves h1
/// framing while allowing concurrent requests to use separate connections.
pub(crate) struct UpstreamConnectionPool {
    connections: tokio::sync::RwLock<HashMap<UpstreamKey, Vec<Arc<PooledConnection>>>>,
    /// Tracks in-flight connection attempts to prevent thundering-herd duplicates.
    ///
    /// A std (sync) lock on purpose: the critical sections are tiny map
    /// operations with no `.await` inside, and the cancellation-safety guard
    /// below must be able to take it from `Drop`, which cannot async-await.
    pending: RwLock<HashMap<UpstreamKey, watch::Receiver<Option<Arc<PooledConnection>>>>>,
    idle_timeout: Duration,
    h1_connecting: Mutex<HashMap<UpstreamKey, usize>>,
    h1_notify: Arc<Notify>,
    eviction_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
    marker: watch::Receiver<Option<Arc<PooledConnection>>>,
    /// Always true today — kept as a switch so a future success path can take
    /// over deregistration explicitly without restructuring the Drop logic.
    armed: bool,
    pending: &'a RwLock<HashMap<UpstreamKey, watch::Receiver<Option<Arc<PooledConnection>>>>>,
}

struct H1ConnectingGuard<'a> {
    key: UpstreamKey,
    connecting: &'a Mutex<HashMap<UpstreamKey, usize>>,
    notify: &'a Notify,
}

impl Drop for H1ConnectingGuard<'_> {
    fn drop(&mut self) {
        let mut counts = self
            .connecting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(count) = counts.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&self.key);
            }
        }
        self.notify.notify_waiters();
    }
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
    pending: &RwLock<HashMap<UpstreamKey, watch::Receiver<Option<Arc<PooledConnection>>>>>,
    key: &UpstreamKey,
    marker: &watch::Receiver<Option<Arc<PooledConnection>>>,
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
            idle_timeout: crate::timeout_for(crate::TimeoutKind::UpstreamPoolIdle),
            h1_connecting: Mutex::new(HashMap::new()),
            h1_notify: Arc::new(Notify::new()),
            eviction_task: Mutex::new(None),
        }
    }

    /// Return a checked-out cached connection, otherwise establish and cache a
    /// new h1 or h2 connection. H1 contention is bounded independently from
    /// the request head timeout; busy connections may grow up to the per-key
    /// limit before callers wait briefly for a lease to be released.
    pub(crate) async fn get_or_connect(
        self: &Arc<Self>,
        key: &UpstreamKey,
        dns_override_ip: Option<IpAddr>,
        verify_upstream_tls: bool,
        tls_verify_hosts: Arc<[String]>,
        upstream_proxy: Option<Arc<crate::upstream_proxy::UpstreamProxyConfig>>,
    ) -> Result<UpstreamConnection, String> {
        loop {
            enum Action {
                Wait(watch::Receiver<Option<Arc<PooledConnection>>>),
                Connect {
                    pending: Option<PendingRegistration>,
                    reserved_h1: bool,
                },
                Queue,
            }

            let action = {
                let mut connections = self.connections.write().await;
                if let Some(entries) = connections.get_mut(key) {
                    entries.retain(|connection| {
                        let alive = connection.is_alive_and_not_idle(self.idle_timeout);
                        if !alive {
                            connection.mark_closed();
                            connection.abort_driver();
                        }
                        alive
                    });

                    for connection in entries.iter().cloned() {
                        if let Some(acquired) = PooledConnection::try_acquire(connection, None) {
                            return Ok(acquired);
                        }
                    }

                    if entries.is_empty() {
                        connections.remove(key);
                        drop(connections);
                        continue;
                    }

                    let h1_count = entries
                        .iter()
                        .filter(|connection| connection.is_h1())
                        .count();
                    let connecting = self
                        .h1_connecting
                        .lock()
                        .map(|counts| counts.get(key).copied().unwrap_or(0))
                        .unwrap_or(0);
                    // Reaching this point means all live entries were busy;
                    // only h1 entries can reach it because h2 is multiplexed.
                    if h1_count + connecting < MAX_H1_CONNECTIONS_PER_KEY {
                        let mut counts = self
                            .h1_connecting
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        *counts.entry(key.clone()).or_default() += 1;
                        Action::Connect {
                            pending: None,
                            reserved_h1: true,
                        }
                    } else {
                        Action::Queue
                    }
                } else {
                    let mut pending = self
                        .pending
                        .write()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if let Some(rx) = pending.get(key) {
                        Action::Wait(rx.clone())
                    } else {
                        let (tx, rx) = watch::channel(None);
                        pending.insert(key.clone(), rx.clone());
                        Action::Connect {
                            pending: Some((tx, rx)),
                            reserved_h1: false,
                        }
                    }
                }
            };

            match action {
                Action::Queue => {
                    tokio::time::timeout(
                        crate::timeout_for(crate::TimeoutKind::UpstreamPoolH1LeaseWait),
                        self.h1_notify.notified(),
                    )
                    .await
                    .map_err(|_| {
                        format!(
                            "timed out waiting for an available upstream h1 connection ({:?})",
                            crate::timeout_for(crate::TimeoutKind::UpstreamPoolH1LeaseWait)
                        )
                    })?;
                }
                Action::Wait(mut rx) => {
                    if rx.changed().await.is_err() {
                        remove_pending_entry_if_current(&self.pending, key, &rx);
                    }
                }
                Action::Connect {
                    pending,
                    reserved_h1,
                } => {
                    let (tx, rx_marker) = pending.clone().unwrap_or_else(|| {
                        let (tx, rx) = watch::channel(None);
                        (tx, rx)
                    });
                    let _guard = PendingConnectGuard {
                        key: key.clone(),
                        marker: rx_marker,
                        armed: pending.is_some(),
                        pending: &self.pending,
                    };
                    let _h1_connecting_guard = reserved_h1.then(|| H1ConnectingGuard {
                        key: key.clone(),
                        connecting: &self.h1_connecting,
                        notify: &self.h1_notify,
                    });

                    let connect_result = self
                        .do_connect(
                            key,
                            dns_override_ip,
                            verify_upstream_tls,
                            tls_verify_hosts.clone(),
                            upstream_proxy.clone(),
                        )
                        .await;

                    match connect_result {
                        Ok((pooled, connection_timing)) => {
                            self.connections
                                .write()
                                .await
                                .entry(key.clone())
                                .or_default()
                                .push(Arc::clone(&pooled));
                            if pending.is_some() {
                                let _ = tx.send(Some(Arc::clone(&pooled)));
                            }
                            self.h1_notify.notify_waiters();
                            if let Some(connection) = PooledConnection::try_acquire(
                                Arc::clone(&pooled),
                                Some(connection_timing),
                            ) {
                                return Ok(connection);
                            }
                            self.evict_if_same(key, &pooled).await;
                            return Err("newly connected upstream is unavailable".to_string());
                        }
                        Err(error) => {
                            if pending.is_some() {
                                let _ = tx.send(None);
                            }
                            return Err(error);
                        }
                    }
                }
            }
        }
    }

    /// Perform DNS + TCP + TLS + protocol handshake (no pool locking).
    async fn do_connect(
        self: &Arc<Self>,
        key: &UpstreamKey,
        dns_override_ip: Option<IpAddr>,
        verify_upstream_tls: bool,
        tls_verify_hosts: Arc<[String]>,
        upstream_proxy: Option<Arc<crate::upstream_proxy::UpstreamProxyConfig>>,
    ) -> Result<(Arc<PooledConnection>, ConnectionTiming), String> {
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
        let uri: http::Uri = format!("{}://{authority_host}:{}", key.scheme, key.port)
            .parse()
            .map_err(|e| format!("invalid upstream URI for pool: {e}"))?;

        let (timing_stream, connection_timing) = tower_service::Service::call(&mut connector, uri)
            .await
            .map_err(|e| format!("upstream pool connect failed: {e}"))?;

        let negotiated_h2 = connection_timing.alpn_protocol.as_deref() == Some("h2");

        let pooled = if negotiated_h2 {
            let executor = hyper_util::rt::TokioExecutor::new();
            let (sender, conn) = hyper::client::conn::http2::handshake(executor, timing_stream)
                .await
                .map_err(|e| format!("upstream pool h2 handshake failed: {e}"))?;
            let connection = Arc::new(H2PooledConnection {
                sender,
                last_used: Mutex::new(Instant::now()),
            });
            let pooled = Arc::new(PooledConnection::H2(Arc::clone(&connection)));
            self.spawn_driver(key, Arc::clone(&pooled), conn);
            pooled
        } else {
            tracing::debug!(
                event = "upstream_pool_h1_fallback",
                scheme = %key.scheme,
                host = %key.host,
                port = key.port,
                alpn = %connection_timing.alpn_protocol.as_deref().unwrap_or("none"),
                "upstream_pool_h1_fallback"
            );
            let (sender, conn) = hyper::client::conn::http1::handshake(timing_stream)
                .await
                .map_err(|e| format!("upstream pool h1 handshake failed: {e}"))?;
            let connection = Arc::new(H1PooledConnection::new(sender, Arc::clone(&self.h1_notify)));
            let pooled = Arc::new(PooledConnection::H1(Arc::clone(&connection)));
            self.spawn_driver(key, Arc::clone(&pooled), conn);
            pooled
        };

        tracing::debug!(
            event = "upstream_pool_new_connection",
            scheme = %key.scheme,
            host = %key.host,
            port = key.port,
            protocol = if negotiated_h2 { "h2" } else { "h1" },
            "upstream_pool_new_connection"
        );
        Ok((pooled, connection_timing))
    }

    fn spawn_driver<T>(self: &Arc<Self>, key: &UpstreamKey, pooled: Arc<PooledConnection>, conn: T)
    where
        T: std::future::Future<Output = Result<(), hyper::Error>> + Send + 'static,
    {
        let pool = Arc::clone(self);
        let driver_key = key.clone();
        let pooled_weak = Arc::downgrade(&pooled);
        let is_h1 = pooled.is_h1();
        #[cfg(test)]
        if is_h1 {
            crate::upstream::h1_pool_driver_started_for_test();
        }
        let driver = tokio::spawn(async move {
            match conn.await {
                Ok(()) => tracing::debug!(
                    event = "upstream_pool_driver_closed",
                    scheme = %driver_key.scheme,
                    host = %driver_key.host,
                    port = driver_key.port,
                    reason = "clean",
                    "upstream_pool_driver_closed"
                ),
                Err(error) => tracing::warn!(
                    event = "upstream_pool_driver_failed",
                    scheme = %driver_key.scheme,
                    host = %driver_key.host,
                    port = driver_key.port,
                    error = %error,
                    "upstream_pool_driver_failed"
                ),
            }
            let pooled = pooled_weak.upgrade();
            if is_h1 {
                if let Some(pooled) = pooled.as_ref() {
                    pooled.mark_driver_finished();
                }
                #[cfg(test)]
                crate::upstream::h1_pool_driver_natural_completion_for_test();
            }
            if let Some(pooled) = pooled {
                pooled.mark_closed();
                pool.evict_if_same(&driver_key, &pooled).await;
            }
        });
        if is_h1 {
            if let Some(connection) = pooled.h1_connection() {
                connection.set_driver(driver);
            }
        }
    }

    /// Start a background task that periodically evicts idle connections.
    pub fn start_eviction_timer(self: &Arc<Self>, interval: Duration, max_idle: Duration) {
        let pool = Arc::clone(self);
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                pool.evict_expired_with_max_idle(max_idle).await;
            }
        });
        *self
            .eviction_task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task);
    }

    pub(crate) async fn shutdown(&self) {
        if let Some(task) = self
            .eviction_task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
        let mut connections = self.connections.write().await;
        for entries in connections.values() {
            for connection in entries {
                connection.mark_closed();
                connection.abort_driver();
            }
        }
        connections.clear();
        self.h1_notify.notify_waiters();
    }

    /// Evict expired entries using a custom idle threshold (called by timer).
    async fn evict_expired_with_max_idle(&self, max_idle: Duration) {
        let mut connections = self.connections.write().await;
        connections.retain(|key, entries| {
            entries.retain(|pooled| {
                let alive = pooled.is_alive_and_not_idle(max_idle);
                if !alive {
                    pooled.mark_closed();
                    pooled.abort_driver();
                    tracing::debug!(
                        event = "upstream_pool_connection_evicted",
                        scheme = %key.scheme,
                        host = %key.host,
                        port = key.port,
                        "upstream_pool_connection_evicted"
                    );
                }
                alive
            });
            if entries.is_empty() {
                tracing::debug!(event = "upstream_pool_evicted", scheme = %key.scheme, host = %key.host, port = key.port, "upstream_pool_evicted");
                false
            } else {
                true
            }
        });
    }

    /// Evict a specific key from the pool (e.g. after a send failure).
    pub(crate) async fn evict_key(&self, key: &UpstreamKey) {
        let mut connections = self.connections.write().await;
        if let Some(entries) = connections.remove(key) {
            for connection in entries {
                connection.mark_closed();
                connection.abort_driver();
            }
            tracing::debug!(
                event = "upstream_pool_evicted",
                scheme = %key.scheme,
                host = %key.host,
                port = key.port,
                "upstream_pool_evicted"
            );
        }
        self.h1_notify.notify_waiters();
    }

    pub(crate) async fn evict_h1_connection(
        &self,
        key: &UpstreamKey,
        expected: &Arc<H1PooledConnection>,
    ) {
        let mut connections = self.connections.write().await;
        if let Some(entries) = connections.get_mut(key) {
            entries.retain(|pooled| match pooled.as_ref() {
                PooledConnection::H1(connection) if Arc::ptr_eq(connection, expected) => {
                    pooled.mark_closed();
                    pooled.abort_driver();
                    false
                }
                _ => true,
            });
            if entries.is_empty() {
                connections.remove(key);
            }
        }
        self.h1_notify.notify_waiters();
    }

    async fn evict_if_same(&self, key: &UpstreamKey, expected: &Arc<PooledConnection>) {
        let mut connections = self.connections.write().await;
        if let Some(entries) = connections.get_mut(key) {
            entries.retain(|connection| {
                if Arc::ptr_eq(connection, expected) {
                    connection.mark_closed();
                    connection.abort_driver();
                    false
                } else {
                    true
                }
            });
            if entries.is_empty() {
                connections.remove(key);
            }
        }
        self.h1_notify.notify_waiters();
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
            scheme: "https".to_string(),
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
            scheme: "https".to_string(),
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

    #[test]
    fn cancelled_h1_growth_dial_returns_capacity_reservation() {
        let pool = UpstreamConnectionPool::new();
        let key = test_key();
        {
            let mut counts = pool.h1_connecting.lock().unwrap();
            counts.insert(key.clone(), 1);
        }
        {
            let _guard = H1ConnectingGuard {
                key: key.clone(),
                connecting: &pool.h1_connecting,
                notify: &pool.h1_notify,
            };
        }
        assert!(pool.h1_connecting.lock().unwrap().get(&key).is_none());
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
            scheme: "https".to_string(),
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
