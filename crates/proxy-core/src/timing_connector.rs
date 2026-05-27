use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use http::uri::Scheme;
use http::Uri;
use hyper::rt::{Read, ReadBufCursor, Write};
use hyper_util::client::legacy::connect::{Connected, Connection};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
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
        let tls_connector = build_dangerous_tls_connector();
        Self {
            dns_override_ip,
            tls_connector: Arc::new(tls_connector),
        }
    }
}

impl Service<Uri> for TimingConnector {
    type Response = (TimingStream, ConnectionTiming);
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
                (TimingStream::Tls(tls_stream), Some(tls_ms), alpn)
            } else {
                (TimingStream::Plain(tcp_stream), None, None)
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

/// Wrapper around a connected stream that implements hyper's IO traits.
///
/// Carries either a plain TCP stream or a TLS-wrapped stream. The hyper Read/Write
/// trait implementations bridge from tokio's AsyncRead/AsyncWrite, following the same
/// pattern as `hyper_util::rt::TokioIo`.
pub enum TimingStream {
    Plain(TcpStream),
    Tls(TlsStream<TcpStream>),
}

impl Connection for TimingStream {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

impl Read for TimingStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        mut buf: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        let n = unsafe {
            let mut tbuf = tokio::io::ReadBuf::uninit(buf.as_mut());
            let poll_result = match self.get_mut() {
                TimingStream::Plain(stream) => Pin::new(stream).poll_read(cx, &mut tbuf),
                TimingStream::Tls(stream) => Pin::new(stream).poll_read(cx, &mut tbuf),
            };
            match poll_result {
                Poll::Ready(Ok(())) => tbuf.filled().len(),
                other => return other,
            }
        };
        unsafe {
            buf.advance(n);
        }
        Poll::Ready(Ok(()))
    }
}

impl Write for TimingStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            TimingStream::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            TimingStream::Tls(stream) => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            TimingStream::Plain(stream) => Pin::new(stream).poll_flush(cx),
            TimingStream::Tls(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            TimingStream::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            TimingStream::Tls(stream) => Pin::new(stream).poll_shutdown(cx),
        }
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

/// Build a TLS connector that accepts any server certificate.
///
/// This is a debugging proxy, not a security boundary. The current reqwest
/// client also uses no certificate verification for upstream connections.
fn build_dangerous_tls_connector() -> TlsConnector {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::crypto::ring::default_provider;
    use rustls::{ClientConfig, DigitallySignedStruct, Error, SignatureScheme};

    #[derive(Debug)]
    struct AcceptAnyCert;

    impl ServerCertVerifier for AcceptAnyCert {
        fn verify_server_cert(
            &self,
            _end_entity: &rustls::pki_types::CertificateDer<'_>,
            _intermediates: &[rustls::pki_types::CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: rustls::pki_types::UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &rustls::pki_types::CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &rustls::pki_types::CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
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

    let provider = default_provider();
    let mut config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .expect("safe default protocol versions should always be available")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyCert))
        .with_no_client_auth();

    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    TlsConnector::from(Arc::new(config))
}
