/// Structured error type for proxy-core operations.
/// Introduced as part of P1 code quality governance to replace ad-hoc
/// `String` errors with structured variants that preserve error context.
///
/// Variants use `#[source]` where the original error type carries structured
/// information (IO errors, HTTP response building errors). Purely descriptive
/// errors (rule messages, breakpoint context) remain as `String`.
#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("upstream connection failed: {message}")]
    UpstreamError {
        kind: UpstreamFailureKind,
        message: String,
    },

    /// The upstream did not deliver a response HEAD within the configured
    /// request timeout (P1-5). Distinct from [`ProxyError::UpstreamError`] so
    /// the proxy layer can answer 504 Gateway Timeout instead of 502. The
    /// response BODY is deliberately not covered by this deadline — a body
    /// that keeps producing chunks may take arbitrarily long and is bounded
    /// per-chunk by the response-body idle timeout instead.
    #[error("upstream did not respond within {timeout_secs}s")]
    UpstreamTimeout { timeout_secs: u64 },

    #[error("TLS handshake failed: {0}")]
    TlsError(String),

    #[error("rule application failed: {0}")]
    RuleError(String),

    #[error("breakpoint cancelled")]
    BreakpointCancelled,

    #[error("request dropped by breakpoint")]
    RequestDropped,

    #[error("script execution timeout")]
    ScriptTimeout,

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    /// HTTP response construction failure.
    /// Preserves the original `http::Error` via `#[source]` so the error
    /// chain is available for tracing and programmatic inspection.
    #[error("failed to build HTTP response: {0}")]
    ResponseBuildError(#[source] http::Error),

    #[error("{0}")]
    Other(String),
}

/// Stable failure classes shared by the session store, diagnostics, and UI.
/// Keep these strings in sync with `SessionFailure` consumers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamFailureKind {
    Dns,
    ConnectRefused,
    ConnectTimeout,
    UpstreamTls,
    UpstreamReset,
    UpstreamTimeout,
    Other,
}

impl UpstreamFailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dns => "dns",
            Self::ConnectRefused => "connect_refused",
            Self::ConnectTimeout => "connect_timeout",
            Self::UpstreamTls => "upstream_tls",
            Self::UpstreamReset => "upstream_reset",
            Self::UpstreamTimeout => "upstream_timeout",
            Self::Other => "other",
        }
    }
}

impl ProxyError {
    pub fn upstream(kind: UpstreamFailureKind, message: impl Into<String>) -> Self {
        Self::UpstreamError {
            kind,
            message: message.into(),
        }
    }

    pub fn upstream_from_io(message: impl Into<String>, error: &std::io::Error) -> Self {
        let kind = match error.kind() {
            std::io::ErrorKind::NotFound => UpstreamFailureKind::Dns,
            std::io::ErrorKind::ConnectionRefused => UpstreamFailureKind::ConnectRefused,
            std::io::ErrorKind::TimedOut => UpstreamFailureKind::ConnectTimeout,
            std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::UnexpectedEof => UpstreamFailureKind::UpstreamReset,
            std::io::ErrorKind::InvalidData => UpstreamFailureKind::UpstreamTls,
            _ => UpstreamFailureKind::Other,
        };
        Self::upstream(kind, format!("{}: {error}", message.into()))
    }

    pub fn upstream_from_hyper(message: impl Into<String>, error: &hyper::Error) -> Self {
        let kind = if error.is_timeout() {
            UpstreamFailureKind::UpstreamTimeout
        } else if error.is_closed() || error.is_incomplete_message() {
            UpstreamFailureKind::UpstreamReset
        } else {
            UpstreamFailureKind::Other
        };
        Self::upstream(kind, format!("{}: {error}", message.into()))
    }
}

impl From<String> for ProxyError {
    fn from(s: String) -> Self {
        ProxyError::Other(s)
    }
}

/// Convenience conversion from ProxyError to String for Tauri command boundaries.
/// At the Tauri command layer, errors are still returned as `Result<T, String>`.
impl From<ProxyError> for String {
    fn from(err: ProxyError) -> Self {
        err.to_string()
    }
}
