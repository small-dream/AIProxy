#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TimeoutKind {
    ClientHeaderRead,
    UpstreamRequest,
    ConnectTunnelConnect,
    TunnelIdle,
    BreakpointWait,
    WsCloseGrace,
    WsFrameIdle,
    WsFrameRead,
    ResponseBodyReadIdle,
    WsUpstreamBodyReadIdle,
    UpstreamProxyDial,
    UpstreamPoolIdle,
    UpstreamPoolH1LeaseWait,
    Http2KeepAliveInterval,
    Http2KeepAliveTimeout,
    UpstreamPoolEvictionInterval,
    UpstreamPoolEvictionMaxIdle,
}

impl TimeoutKind {
    const fn default_duration(self) -> Duration {
        match self {
            Self::ClientHeaderRead => Duration::from_secs(30),
            Self::UpstreamRequest => Duration::from_secs(120),
            Self::ConnectTunnelConnect => Duration::from_secs(30),
            Self::TunnelIdle => Duration::from_secs(10 * 60),
            Self::BreakpointWait => Duration::from_secs(5 * 60),
            Self::WsCloseGrace => Duration::from_secs(5),
            Self::WsFrameIdle => Duration::from_secs(5 * 60),
            Self::WsFrameRead => Duration::from_secs(30),
            Self::ResponseBodyReadIdle => Duration::from_secs(30),
            Self::WsUpstreamBodyReadIdle => Duration::from_secs(10),
            Self::UpstreamProxyDial => Duration::from_secs(20),
            Self::UpstreamPoolIdle => Duration::from_secs(60),
            Self::UpstreamPoolH1LeaseWait => Duration::from_secs(5),
            Self::Http2KeepAliveInterval => Duration::from_secs(30),
            Self::Http2KeepAliveTimeout => Duration::from_secs(20),
            Self::UpstreamPoolEvictionInterval => Duration::from_secs(60),
            Self::UpstreamPoolEvictionMaxIdle => Duration::from_secs(120),
        }
    }

    #[cfg(test)]
    const fn test_override_slot(self) -> &'static AtomicU64 {
        static CLIENT_HEADER_READ_MS: AtomicU64 = AtomicU64::new(0);
        static UPSTREAM_REQUEST_MS: AtomicU64 = AtomicU64::new(0);
        static CONNECT_TUNNEL_CONNECT_MS: AtomicU64 = AtomicU64::new(0);
        static TUNNEL_IDLE_MS: AtomicU64 = AtomicU64::new(0);
        static BREAKPOINT_WAIT_MS: AtomicU64 = AtomicU64::new(0);
        static WS_CLOSE_GRACE_MS: AtomicU64 = AtomicU64::new(0);
        static WS_FRAME_IDLE_MS: AtomicU64 = AtomicU64::new(0);
        static WS_FRAME_READ_MS: AtomicU64 = AtomicU64::new(0);
        static RESPONSE_BODY_READ_IDLE_MS: AtomicU64 = AtomicU64::new(0);
        static WS_UPSTREAM_BODY_READ_IDLE_MS: AtomicU64 = AtomicU64::new(0);
        static UPSTREAM_PROXY_DIAL_MS: AtomicU64 = AtomicU64::new(0);
        static UPSTREAM_POOL_IDLE_MS: AtomicU64 = AtomicU64::new(0);
        static UPSTREAM_POOL_H1_LEASE_WAIT_MS: AtomicU64 = AtomicU64::new(0);
        static HTTP2_KEEP_ALIVE_INTERVAL_MS: AtomicU64 = AtomicU64::new(0);
        static HTTP2_KEEP_ALIVE_TIMEOUT_MS: AtomicU64 = AtomicU64::new(0);
        static UPSTREAM_POOL_EVICTION_INTERVAL_MS: AtomicU64 = AtomicU64::new(0);
        static UPSTREAM_POOL_EVICTION_MAX_IDLE_MS: AtomicU64 = AtomicU64::new(0);
        match self {
            Self::ClientHeaderRead => &CLIENT_HEADER_READ_MS,
            Self::UpstreamRequest => &UPSTREAM_REQUEST_MS,
            Self::ConnectTunnelConnect => &CONNECT_TUNNEL_CONNECT_MS,
            Self::TunnelIdle => &TUNNEL_IDLE_MS,
            Self::BreakpointWait => &BREAKPOINT_WAIT_MS,
            Self::WsCloseGrace => &WS_CLOSE_GRACE_MS,
            Self::WsFrameIdle => &WS_FRAME_IDLE_MS,
            Self::WsFrameRead => &WS_FRAME_READ_MS,
            Self::ResponseBodyReadIdle => &RESPONSE_BODY_READ_IDLE_MS,
            Self::WsUpstreamBodyReadIdle => &WS_UPSTREAM_BODY_READ_IDLE_MS,
            Self::UpstreamProxyDial => &UPSTREAM_PROXY_DIAL_MS,
            Self::UpstreamPoolIdle => &UPSTREAM_POOL_IDLE_MS,
            Self::UpstreamPoolH1LeaseWait => &UPSTREAM_POOL_H1_LEASE_WAIT_MS,
            Self::Http2KeepAliveInterval => &HTTP2_KEEP_ALIVE_INTERVAL_MS,
            Self::Http2KeepAliveTimeout => &HTTP2_KEEP_ALIVE_TIMEOUT_MS,
            Self::UpstreamPoolEvictionInterval => &UPSTREAM_POOL_EVICTION_INTERVAL_MS,
            Self::UpstreamPoolEvictionMaxIdle => &UPSTREAM_POOL_EVICTION_MAX_IDLE_MS,
        }
    }
}

/// Single source of truth for proxy lifecycle deadlines.
pub(crate) fn timeout(kind: TimeoutKind) -> Duration {
    #[cfg(test)]
    {
        let timeout_ms = kind.test_override_slot().load(Ordering::SeqCst);
        if timeout_ms > 0 {
            return Duration::from_millis(timeout_ms);
        }
    }

    kind.default_duration()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_timeout_kind_has_a_positive_default() {
        let kinds = [
            TimeoutKind::ClientHeaderRead,
            TimeoutKind::UpstreamRequest,
            TimeoutKind::ConnectTunnelConnect,
            TimeoutKind::TunnelIdle,
            TimeoutKind::BreakpointWait,
            TimeoutKind::WsCloseGrace,
            TimeoutKind::WsFrameIdle,
            TimeoutKind::WsFrameRead,
            TimeoutKind::ResponseBodyReadIdle,
            TimeoutKind::WsUpstreamBodyReadIdle,
            TimeoutKind::UpstreamProxyDial,
            TimeoutKind::UpstreamPoolIdle,
            TimeoutKind::UpstreamPoolH1LeaseWait,
            TimeoutKind::Http2KeepAliveInterval,
            TimeoutKind::Http2KeepAliveTimeout,
            TimeoutKind::UpstreamPoolEvictionInterval,
            TimeoutKind::UpstreamPoolEvictionMaxIdle,
        ];
        assert!(kinds.into_iter().all(|kind| timeout(kind) > Duration::ZERO));
    }

    #[test]
    fn test_override_is_scoped_to_one_kind() {
        let before = timeout(TimeoutKind::UpstreamRequest);
        let _guard =
            override_timeout_for_test(TimeoutKind::UpstreamRequest, Duration::from_millis(17));
        assert_eq!(
            timeout(TimeoutKind::UpstreamRequest),
            Duration::from_millis(17)
        );
        assert_ne!(timeout(TimeoutKind::TunnelIdle), Duration::from_millis(17));
        drop(_guard);
        assert_eq!(timeout(TimeoutKind::UpstreamRequest), before);
    }
}

#[cfg(test)]
pub(crate) fn override_timeout_for_test(kind: TimeoutKind, timeout: Duration) -> TestTimeoutGuard {
    kind.test_override_slot()
        .store(timeout.as_millis() as u64, Ordering::SeqCst);
    TestTimeoutGuard {
        slot: kind.test_override_slot(),
    }
}

#[cfg(test)]
pub(crate) struct TestTimeoutGuard {
    slot: &'static AtomicU64,
}

#[cfg(test)]
impl Drop for TestTimeoutGuard {
    fn drop(&mut self) {
        self.slot.store(0, Ordering::SeqCst);
    }
}
