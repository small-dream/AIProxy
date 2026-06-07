/// Structured error type for proxy-core operations.
/// Introduced as part of P1 code quality governance to replace ad-hoc
/// `String` errors with structured variants that preserve error context.
///
/// Variants use `#[source]` where the original error type carries structured
/// information (IO errors, HTTP response building errors). Purely descriptive
/// errors (rule messages, breakpoint context) remain as `String`.
#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("upstream connection failed: {0}")]
    UpstreamError(String),

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
