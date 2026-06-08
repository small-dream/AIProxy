use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use crate::stream::TlsOrPlain;
use http::uri::Scheme;
use http::Uri;
use rustls::pki_types::ServerName;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tower_service::Service;

/// Measured connection phase durations.
#[derive(Debug, Clone)]
pub struct ConnectionTiming {
    pub dns_ms: u128,
    pub connect_ms: u128,
    pub tls_ms: Option<u128>,
    /// The ALPN protocol negotiated during TLS handshake (e.g. "h2", "http/1.1").
    pub alpn_protocol: Option<String>,
}

/// A timing-aware connector for hyper's legacy client.
///
/// Measures DNS resolution, TCP connect, and TLS handshake phases individually.
/// Accepts an optional DNS override IP to bypass DNS when a mapping is configured.
#[derive(Clone)]
pub struct TimingConnector {
    dns_override_ip: Option<IpAddr>,
    tls_connector: Arc<TlsConnector>,
}

impl TimingConnector {
    pub fn new(dns_override_ip: Option<IpAddr>) -> Self {
        let tls_connector =
            aiproxy_tls_manager::client::build_dangerous_tls_connector_with_alpn(vec![
                b"h2".to_vec(),
                b"http/1.1".to_vec(),
            ]);
        Self {
            dns_override_ip,
            tls_connector: Arc::new(tls_connector),
        }
    }
}

impl Service<Uri> for TimingConnector {
    type Response = (TlsOrPlain<TcpStream>, ConnectionTiming);
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let dns_override_ip = self.dns_override_ip;
        let tls_connector = Arc::clone(&self.tls_connector);

        Box::pin(async move {
            let host = uri.host().unwrap_or("").to_owned();
            let port = uri_port(&uri);
            let is_https = uri.scheme() == Some(&Scheme::HTTPS);

            // Phase 1: DNS resolution (or skip if override provided)
            let (dns_ms, socket_addr) = if let Some(ip) = dns_override_ip {
                (0, SocketAddr::new(ip, port))
            } else {
                let started = Instant::now();
                let addr = resolve_host(&host, port).await?;
                (started.elapsed().as_millis(), addr)
            };

            // Phase 2: TCP connect
            let tcp_started = Instant::now();
            let tcp_stream = TcpStream::connect(socket_addr).await?;
            let connect_ms = tcp_started.elapsed().as_millis();

            // Phase 3: TLS handshake (HTTPS only)
            let (timing_stream, tls_ms, alpn_protocol) = if is_https {
                let tls_started = Instant::now();
                let server_name = ServerName::try_from(host.clone()).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "invalid server name for TLS")
                })?;
                let tls_stream = tls_connector.connect(server_name, tcp_stream).await?;
                let tls_ms = tls_started.elapsed().as_millis();
                let alpn = tls_stream
                    .get_ref()
                    .1
                    .alpn_protocol()
                    .map(|s| String::from_utf8_lossy(s).into_owned());
                (TlsOrPlain::Tls(Box::new(tls_stream)), Some(tls_ms), alpn)
            } else {
                (TlsOrPlain::Plain(tcp_stream), None, None)
            };

            let timing = ConnectionTiming {
                dns_ms,
                connect_ms,
                tls_ms,
                alpn_protocol,
            };

            Ok((timing_stream, timing))
        })
    }
}

/// Factory function to create a timing connector with an optional DNS override.
pub fn create_timing_connector(dns_override_ip: Option<IpAddr>) -> TimingConnector {
    TimingConnector::new(dns_override_ip)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn uri_port(uri: &Uri) -> u16 {
    uri.port_u16().unwrap_or(match uri.scheme() {
        Some(scheme) if scheme == &Scheme::HTTPS => 443,
        _ => 80,
    })
}

async fn resolve_host(host: &str, port: u16) -> io::Result<SocketAddr> {
    let lookup_target = format!("{host}:{port}");
    let mut addrs = tokio::net::lookup_host(&lookup_target).await?;
    addrs.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("DNS lookup failed for {host}"),
        )
    })
}
