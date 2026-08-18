use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use crate::stream::TlsOrPlain;
use crate::upstream_proxy::{dial_target, DialRoute, DialedStream, UpstreamProxyConfig};
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
    /// Whether this connection was tunneled through the configured upstream
    /// proxy. Surfaced in session details so a user can tell at a glance
    /// whether a request took the chained route or went out directly.
    pub via_upstream_proxy: bool,
}

/// A timing-aware connector for hyper's legacy client.
///
/// Measures DNS resolution, TCP connect, and TLS handshake phases individually.
/// Accepts an optional DNS override IP to bypass DNS when a mapping is configured.
///
/// H3: holds a dangerous (NoOp-verifier) `TlsConnector` and a lazily-built
/// verifying `TlsConnector`, and picks one per connection. The effective
/// verify decision is `verify_upstream_tls || tls_verify_hosts.contains(host)`
/// — so a host on the allowlist is verified even when the global switch is off.
///
/// The verifying connector is built lazily on first use because building it
/// clones the OS native root store + assembles a `ClientConfig`, which is
/// wasted work on plain-HTTP requests or when verification is off. This
/// matters because the h1 path constructs a new `TimingConnector` per
/// request. The dangerous connector is cheap (OnceLock-cached config) and
/// built eagerly.
#[derive(Clone)]
pub struct TimingConnector {
    dns_override_ip: Option<IpAddr>,
    /// NoOp-verifier connector (accepts any upstream cert) — the historical
    /// debug-proxy default. Cheap; built eagerly.
    dangerous_tls_connector: Arc<TlsConnector>,
    /// Verifying connector (OS root store) — built lazily on first verify
    /// decision so plain-HTTP / verify-off requests never pay the root-store
    /// cost. `OnceLock` makes the first-build race-safe; subsequent verifiers
    /// reuse the cached connector.
    verifying_tls_connector: Arc<std::sync::OnceLock<TlsConnector>>,
    verify_upstream_tls: bool,
    tls_verify_hosts: Arc<[String]>,
    /// Upstream (chained) proxy to tunnel through, when configured.
    upstream_proxy: Option<Arc<UpstreamProxyConfig>>,
}

impl TimingConnector {
    pub fn new(
        dns_override_ip: Option<IpAddr>,
        verify_upstream_tls: bool,
        tls_verify_hosts: Arc<[String]>,
        upstream_proxy: Option<Arc<UpstreamProxyConfig>>,
    ) -> Self {
        let alpn = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        // Dangerous connector is OnceLock-cached in tls-manager and cheap to
        // build, so construct it eagerly — it's needed for the common case
        // (verify off / non-allowlisted host).
        let dangerous_tls_connector =
            aiproxy_tls_manager::client::build_tls_connector_with_alpn_and_verify(
                alpn.clone(),
                false,
            );
        Self {
            dns_override_ip,
            dangerous_tls_connector: Arc::new(dangerous_tls_connector),
            verifying_tls_connector: Arc::new(std::sync::OnceLock::new()),
            verify_upstream_tls,
            tls_verify_hosts,
            upstream_proxy,
        }
    }

    /// H3: decide whether to verify the TLS cert for `host`. Verify when the
    /// global switch is on OR the host is on the per-host allowlist.
    fn should_verify(&self, host: &str) -> bool {
        self.verify_upstream_tls || host_in_allowlist(&self.tls_verify_hosts, host)
    }
}

/// Case-insensitive, exact-hostname membership check against the allowlist.
/// We do not support wildcard/CIDR matching — only literal hostnames, which
/// matches what the Settings UI lets the user enter (one host per line).
///
/// Both sides go through [`crate::host_pattern::normalize_host_token`]: the
/// host arrives bracketed for IPv6 authorities (`[2001:db8::5]`), while a user
/// typing the allowlist entry spells it bare — without normalization the
/// verify allowlist would silently never match those hosts.
pub(crate) fn host_in_allowlist(allowlist: &[String], host: &str) -> bool {
    let host = crate::host_pattern::normalize_host_token(host);
    if host.is_empty() {
        return false;
    }
    allowlist
        .iter()
        .any(|entry| crate::host_pattern::normalize_host_token(entry).eq_ignore_ascii_case(host))
}

/// Strip the brackets of an IPv6 authority so `ServerName` accepts it —
/// `ServerName::try_from("[2001:db8::5]")` fails because the brackets are not
/// part of the address, while `Url::host_str()` keeps them. Shared by every
/// outbound TLS path (h1/h2 connector, WebSocket upgrade, proxy hop).
pub(crate) fn tls_server_name_host(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host)
}

impl Service<Uri> for TimingConnector {
    type Response = (TlsOrPlain<DialedStream>, ConnectionTiming);
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let dns_override_ip = self.dns_override_ip;
        // H3: compute the effective verify decision for THIS host. The verifying
        // connector is resolved lazily inside the HTTPS branch below, so a
        // plain-HTTP request or a verify=false/allowlist-miss HTTPS request
        // never pays the OS root-store build cost.
        let host_for_decision = uri.host().unwrap_or("").to_owned();
        let verify = self.should_verify(&host_for_decision);
        let dangerous_tls_connector = Arc::clone(&self.dangerous_tls_connector);
        let verifying_tls_connector = Arc::clone(&self.verifying_tls_connector);
        let upstream_proxy = self.upstream_proxy.clone();

        Box::pin(async move {
            let host = host_for_decision;
            let port = uri_port(&uri);
            // R6-1: treat `wss` like `https` (same TLS transport). The WS upgrade
            // path connects upstream directly and never reaches this connector,
            // but keep the scheme check aligned for robustness.
            let is_https = matches!(
                uri.scheme().map(|s| s.as_str()),
                Some("https") | Some("wss")
            );

            // Phases 1+2: resolve and connect.
            //
            // The two branches differ in *who* resolves DNS. A direct
            // connection resolves locally, so we can report a real `dns_ms`.
            // A proxied connection deliberately does not: the hostname has to
            // reach the upstream proxy intact for its routing rules to match,
            // so resolution happens on the proxy side and `dns_ms` stays 0.
            // `connect_ms` then covers the whole negotiation (TCP to the proxy
            // + any proxy-hop TLS + the CONNECT/SOCKS5 handshake).
            let proxy_handles_this_host = upstream_proxy
                .as_ref()
                .is_some_and(|proxy| !proxy.should_bypass(&host));

            let (dns_ms, connect_ms, dialed, via_upstream_proxy) = if proxy_handles_this_host {
                let started = Instant::now();
                let (stream, route) =
                    dial_target(upstream_proxy.as_deref(), &host, port, dns_override_ip).await?;
                (
                    0,
                    started.elapsed().as_millis(),
                    stream,
                    route == DialRoute::UpstreamProxy,
                )
            } else {
                let (dns_ms, socket_addr) = if let Some(ip) = dns_override_ip {
                    (0, SocketAddr::new(ip, port))
                } else {
                    let started = Instant::now();
                    let addr = resolve_host(&host, port).await?;
                    (started.elapsed().as_millis(), addr)
                };

                let tcp_started = Instant::now();
                let tcp_stream = TcpStream::connect(socket_addr).await?;
                (
                    dns_ms,
                    tcp_started.elapsed().as_millis(),
                    TlsOrPlain::Plain(tcp_stream),
                    false,
                )
            };

            // Phase 3: TLS handshake (HTTPS only). The connector is selected
            // here — lazily building the verifying one only when this is an
            // HTTPS request AND verify is effective for the host.
            let (timing_stream, tls_ms, alpn_protocol) = if is_https {
                let tls_connector = if verify {
                    // First verify-effective HTTPS request builds the verifying
                    // connector (root-store clone + ClientConfig); later ones
                    // reuse the OnceLock-cached instance on this connector.
                    verifying_tls_connector
                        .get_or_init(|| {
                            aiproxy_tls_manager::client::build_tls_connector_with_alpn_and_verify(
                                vec![b"h2".to_vec(), b"http/1.1".to_vec()],
                                true,
                            )
                        })
                        .clone()
                } else {
                    dangerous_tls_connector.as_ref().clone()
                };
                let tls_started = Instant::now();
                let server_name = ServerName::try_from(tls_server_name_host(&host).to_owned())
                    .map_err(|_| {
                        io::Error::new(io::ErrorKind::InvalidInput, "invalid server name for TLS")
                    })?;
                let tls_stream = tls_connector.connect(server_name, dialed).await?;
                let tls_ms = tls_started.elapsed().as_millis();
                let alpn = tls_stream
                    .get_ref()
                    .1
                    .alpn_protocol()
                    .map(|s| String::from_utf8_lossy(s).into_owned());
                (TlsOrPlain::Tls(Box::new(tls_stream)), Some(tls_ms), alpn)
            } else {
                (TlsOrPlain::Plain(dialed), None, None)
            };

            let timing = ConnectionTiming {
                dns_ms,
                connect_ms,
                tls_ms,
                alpn_protocol,
                via_upstream_proxy,
            };

            Ok((timing_stream, timing))
        })
    }
}

/// Factory function to create a timing connector with an optional DNS override.
///
/// H3: `verify_upstream_tls` selects the upstream TLS verification mode;
/// `tls_verify_hosts` is the per-host allowlist that forces verification
/// regardless of the global flag (see [`TimingConnector::new`]).
pub fn create_timing_connector(
    dns_override_ip: Option<IpAddr>,
    verify_upstream_tls: bool,
    tls_verify_hosts: Arc<[String]>,
    upstream_proxy: Option<Arc<UpstreamProxyConfig>>,
) -> TimingConnector {
    TimingConnector::new(
        dns_override_ip,
        verify_upstream_tls,
        tls_verify_hosts,
        upstream_proxy,
    )
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

#[cfg(test)]
mod tests {
    use super::tls_server_name_host;

    #[test]
    fn tls_server_name_host_unwraps_ipv6_brackets() {
        assert_eq!(tls_server_name_host("[2001:db8::5]"), "2001:db8::5");
        assert_eq!(tls_server_name_host("example.com"), "example.com");
        assert_eq!(tls_server_name_host("127.0.0.1"), "127.0.0.1");
        // A stray opening bracket without its pair is left untouched rather
        // than mangled.
        assert_eq!(tls_server_name_host("[broken"), "[broken");
    }

    #[test]
    fn allowlist_matches_ipv6_hosts_across_bracket_spellings() {
        // The connector decides verification from `uri.host()`, which keeps
        // the brackets of an IPv6 authority; the user types the allowlist
        // entry bare. Without normalization the allowlist silently never
        // matched those hosts.
        let allowlist = vec!["2001:db8::5".to_string(), "api.example.com".to_string()];

        assert!(host_in_allowlist(&allowlist, "[2001:db8::5]"));
        assert!(host_in_allowlist(&allowlist, "2001:db8::5"));
        assert!(host_in_allowlist(&allowlist, "API.example.com."));
        assert!(!host_in_allowlist(&allowlist, "[2001:db8::6]"));

        // Entries typed with brackets (copy-pasted from a URL) also match.
        let bracketed = vec!["[2001:db8::5]".to_string()];
        assert!(host_in_allowlist(&bracketed, "[2001:db8::5]"));
        assert!(host_in_allowlist(&bracketed, "2001:db8::5"));
    }

    use super::*;
    use tokio::net::TcpListener;

    // H3: verify the verify-upstream-TLS switch end-to-end against a real
    // self-signed TLS upstream. We generate a throwaway root CA + leaf cert
    // (the same primitives the MITM side uses) and stand up a tiny TLS server,
    // then assert that:
    //   - verify=false (the historical default) accepts the self-signed cert
    //     and the handshake succeeds;
    //   - verify=true rejects it because the leaf is NOT in the OS root store
    //     (it's signed by a freshly-generated ephemeral CA).
    //
    // This is a connector-level integration test rather than a full proxy
    // round-trip: the verify switch lives in `TimingConnector`, and the full
    // MITM stack would additionally require trusting AIProxy's own CA, which
    // is orthogonal to upstream verification.

    /// Build a `rustls::ServerConfig` that presents a self-signed leaf for
    /// `127.0.0.1`, signed by a freshly generated ephemeral root CA.
    fn self_signed_server_config() -> Arc<rustls::ServerConfig> {
        let root_ca =
            aiproxy_tls_manager::RootCaPair::generate().expect("generate ephemeral root CA");
        let (cert_der, key_der) =
            aiproxy_tls_manager::generator::sign_host_certificate(&root_ca, "127.0.0.1")
                .expect("sign self-signed leaf for 127.0.0.1");

        let signing_key =
            rustls::crypto::ring::sign::any_supported_type(&key_der).expect("leaf signing key");

        let certified_key = Arc::new(rustls::sign::CertifiedKey::new(vec![cert_der], signing_key));

        // A resolver that always returns our single leaf cert.
        #[derive(Debug)]
        struct StaticResolver(Arc<rustls::sign::CertifiedKey>);
        impl rustls::server::ResolvesServerCert for StaticResolver {
            fn resolve(
                &self,
                _client_hello: rustls::server::ClientHello<'_>,
            ) -> Option<Arc<rustls::sign::CertifiedKey>> {
                Some(Arc::clone(&self.0))
            }
        }

        Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_cert_resolver(Arc::new(StaticResolver(certified_key))),
        )
    }

    /// Spawn a TLS server on an ephemeral port that accepts exactly one
    /// connection and immediately closes it. Returns the bound port. The
    /// server's only job is to complete (or refuse) a TLS handshake.
    async fn spawn_self_signed_tls_upstream() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_config = self_signed_server_config();
        let acceptor = tokio_rustls::TlsAcceptor::from(server_config);
        tokio::spawn(async move {
            // Accept a single connection; we only care about the handshake
            // outcome, so drop the stream immediately after accepting.
            if let Ok((tcp, _)) = listener.accept().await {
                let _ = acceptor.accept(tcp).await;
            }
        });
        port
    }

    fn empty_allowlist() -> Arc<[String]> {
        Arc::from(Vec::<String>::new())
    }

    #[tokio::test]
    async fn h3_verify_off_accepts_self_signed_upstream() {
        let port = spawn_self_signed_tls_upstream().await;
        // Use a DNS override to point 127.0.0.1 at the ephemeral port without
        // depending on /etc/hosts. The connector's TLS handshake is what we
        // exercise; the ServerName is "127.0.0.1".
        let mut connector = TimingConnector::new(
            Some(IpAddr::V4([127, 0, 0, 1].into())),
            false,
            empty_allowlist(),
            None,
        );
        let uri: Uri = format!("https://127.0.0.1:{port}/").parse().unwrap();
        let result = Service::call(&mut connector, uri).await;
        assert!(
            result.is_ok(),
            "verify=false must accept a self-signed upstream cert (the historical default), got: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn h3_verify_on_rejects_self_signed_upstream() {
        let port = spawn_self_signed_tls_upstream().await;
        let mut connector = TimingConnector::new(
            Some(IpAddr::V4([127, 0, 0, 1].into())),
            true,
            empty_allowlist(),
            None,
        );
        let uri: Uri = format!("https://127.0.0.1:{port}/").parse().unwrap();
        let result = Service::call(&mut connector, uri).await;
        assert!(
            result.is_err(),
            "verify=true must reject a self-signed upstream cert that is not in the OS root store"
        );
    }

    // H3 allowlist: even with verify_upstream_tls=false, a host on the
    // per-host allowlist must be verified — so a self-signed cert for an
    // allowlisted host is rejected. This is the acceptance criterion the
    // global-flag-only implementation missed.
    #[tokio::test]
    async fn h3_allowlist_forces_verify_even_when_global_flag_is_off() {
        let port = spawn_self_signed_tls_upstream().await;
        // The self-signed leaf is for "127.0.0.1"; put it on the allowlist.
        let allowlist: Arc<[String]> = Arc::from(vec!["127.0.0.1".to_string()]);
        let mut connector = TimingConnector::new(
            Some(IpAddr::V4([127, 0, 0, 1].into())),
            false, // global verify OFF
            allowlist,
            None,
        );
        let uri: Uri = format!("https://127.0.0.1:{port}/").parse().unwrap();
        let result = Service::call(&mut connector, uri).await;
        assert!(
            result.is_err(),
            "an allowlisted host must be verified even when verify_upstream_tls is false"
        );
    }

    // H3 allowlist: a host NOT on the allowlist with verify=false stays on the
    // dangerous verifier (accepts self-signed). Guards against the allowlist
    // accidentally applying globally.
    #[tokio::test]
    async fn h3_non_allowlisted_host_stays_unverified_when_global_flag_is_off() {
        let port = spawn_self_signed_tls_upstream().await;
        // Allowlist some OTHER host; 127.0.0.1 is not listed.
        let allowlist: Arc<[String]> = Arc::from(vec!["example.com".to_string()]);
        let mut connector = TimingConnector::new(
            Some(IpAddr::V4([127, 0, 0, 1].into())),
            false,
            allowlist,
            None,
        );
        let uri: Uri = format!("https://127.0.0.1:{port}/").parse().unwrap();
        let result = Service::call(&mut connector, uri).await;
        assert!(
            result.is_ok(),
            "a non-allowlisted host must stay on the dangerous verifier when verify_upstream_tls is false"
        );
    }

    // Unit-test the allowlist matcher directly (case-insensitivity, trimming).
    #[test]
    fn h3_host_in_allowlist_matches_case_insensitively() {
        let allowlist: Vec<String> = vec!["Example.COM".into(), "  api.example.org  ".into()];
        assert!(host_in_allowlist(&allowlist, "example.com"));
        assert!(host_in_allowlist(&allowlist, "EXAMPLE.com"));
        assert!(host_in_allowlist(&allowlist, "api.example.org"));
        assert!(!host_in_allowlist(&allowlist, "evil.example.org"));
        assert!(!host_in_allowlist(&allowlist, ""));
    }
}
