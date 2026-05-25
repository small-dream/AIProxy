use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use http_body_util::combinators::BoxBody;
use tokio::sync::RwLock;

use crate::timing_connector::ConnectionTiming;
use crate::emit_log;

/// Key used to look up pooled connections.
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
    connections: RwLock<HashMap<UpstreamKey, PooledConnection>>,
    idle_timeout: Duration,
}

impl UpstreamConnectionPool {
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
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
        &self,
        key: &UpstreamKey,
        dns_override_ip: Option<IpAddr>,
    ) -> Result<
        Option<(
            hyper::client::conn::http2::SendRequest<BoxBody<bytes::Bytes, String>>,
            Option<ConnectionTiming>,
        )>,
        String,
    > {
        // Fast path: check the pool for an existing, live connection.
        {
            let connections = self.connections.read().await;
            if let Some(pooled) = connections.get(key) {
                if !pooled.sender.is_closed() && pooled.last_used.elapsed() < self.idle_timeout {
                    emit_log(
                        "DEBUG",
                        "upstream_pool_reuse",
                        &[
                            ("host", key.host.clone()),
                            ("port", key.port.to_string()),
                        ],
                    );
                    // We don't have timing info for a reused connection.
                    return Ok(Some((pooled.sender.clone(), None)));
                }
            }
        }

        // Slow path: establish a new connection.
        let mut connector = crate::timing_connector::TimingConnector::new(dns_override_ip);
        let uri: http::Uri = format!("https://{}:{}", key.host, key.port)
            .parse()
            .map_err(|e| format!("invalid upstream URI for pool: {e}"))?;

        let (timing_stream, connection_timing) =
            tower_service::Service::call(&mut connector, uri)
                .await
                .map_err(|e| format!("upstream pool connect failed: {e}"))?;

        // Check ALPN — if the upstream did not negotiate h2 we cannot pool this
        // connection as h2. Return None so the caller falls back to h1.
        let negotiated_h2 = connection_timing
            .alpn_protocol
            .as_deref()
            .map_or(false, |proto| proto == "h2");

        if !negotiated_h2 {
            emit_log(
                "DEBUG",
                "upstream_pool_h1_fallback",
                &[
                    ("host", key.host.clone()),
                    ("port", key.port.to_string()),
                    (
                        "alpn",
                        connection_timing
                            .alpn_protocol
                            .as_deref()
                            .unwrap_or("none")
                            .to_string(),
                    ),
                ],
            );
            return Ok(None);
        }

        let executor = hyper_util::rt::TokioExecutor::new();
        let (sender, conn) = hyper::client::conn::http2::handshake(executor, timing_stream)
            .await
            .map_err(|e| format!("upstream pool h2 handshake failed: {e}"))?;

        // Spawn the connection driver task.
        tokio::spawn(async move {
            let _ = conn.await;
        });

        emit_log(
            "DEBUG",
            "upstream_pool_new_connection",
            &[
                ("host", key.host.clone()),
                ("port", key.port.to_string()),
            ],
        );

        // Store in the pool.
        {
            let mut connections = self.connections.write().await;
            connections.insert(
                key.clone(),
                PooledConnection {
                    sender: sender.clone(),
                    last_used: Instant::now(),
                },
            );
        }

        Ok(Some((sender, Some(connection_timing))))
    }

    /// Evict expired entries. Called periodically or opportunistically.
    #[allow(dead_code)]
    pub(crate) async fn evict_expired(&self) {
        let mut connections = self.connections.write().await;
        let idle_timeout = self.idle_timeout;
        connections.retain(|key, pooled| {
            let alive = !pooled.sender.is_closed() && pooled.last_used.elapsed() < idle_timeout;
            if !alive {
                emit_log(
                    "DEBUG",
                    "upstream_pool_evicted",
                    &[
                        ("host", key.host.clone()),
                        ("port", key.port.to_string()),
                    ],
                );
            }
            alive
        });
    }
}
