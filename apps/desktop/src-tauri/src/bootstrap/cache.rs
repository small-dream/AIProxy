use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use aiproxy_proxy_core::{ProxySessionDetail, ProxySessionSummary};

const SESSION_DETAIL_CACHE_CAPACITY: usize = 1_000;
const SESSION_SUMMARY_MAX: usize = 15_000;

/// Bounded LRU for session details.
///
/// The map and the LRU order deque are held behind a single mutex so that
/// insert/evict/touch/remove are each atomic — previously two separate mutexes
/// left windows where a concurrent op could desynchronize the map from the
/// order (M7).
struct DetailState {
    map: HashMap<String, ProxySessionDetail>,
    order: VecDeque<String>,
}

/// In-memory cache for session summaries and a bounded LRU for session details.
///
/// Separated from `AppState` so that cache policies and eviction are testable
/// in isolation, and so that `AppState` focuses on coordination (persistence,
/// events, status).
pub(crate) struct SessionCache {
    details: Mutex<DetailState>,
    summaries: Mutex<Vec<ProxySessionSummary>>,
}

impl SessionCache {
    pub fn new() -> Self {
        Self {
            details: Mutex::new(DetailState {
                map: HashMap::new(),
                order: VecDeque::new(),
            }),
            summaries: Mutex::new(Vec::new()),
        }
    }

    // ── summaries ──────────────────────────────────────────────────

    /// Snapshot of all currently known session summaries.
    pub fn read_summaries(&self) -> Vec<ProxySessionSummary> {
        self.summaries
            .lock()
            .expect("session summaries mutex should not be poisoned")
            .clone()
    }

    /// Look up a summary by id. Returns `None` if not in the in-memory cache.
    pub fn find_summary(&self, session_id: &str) -> Option<ProxySessionSummary> {
        self.summaries
            .lock()
            .expect("session summaries mutex should not be poisoned")
            .iter()
            .find(|s| s.id == session_id)
            .cloned()
    }

    /// Insert or update a summary. Returns the IDs of any summaries evicted
    /// because the cap was exceeded (oldest non-focused first).
    pub fn upsert_summary(
        &self,
        summary: ProxySessionSummary,
        focused_hosts: &HashSet<String>,
    ) -> Vec<String> {
        let mut summaries = self
            .summaries
            .lock()
            .expect("session summaries mutex should not be poisoned");

        if let Some(existing) = summaries.iter_mut().find(|s| s.id == summary.id) {
            *existing = summary;
        } else {
            summaries.push(summary);
        }

        let mut removed = Vec::new();
        while summaries.len() > SESSION_SUMMARY_MAX {
            let idx = select_eviction_index(&summaries, focused_hosts);
            removed.push(summaries.remove(idx).id);
        }
        removed
    }

    /// Remove summaries by ID.
    #[allow(dead_code)]
    pub fn remove_summaries(&self, ids: &HashSet<String>) {
        self.summaries
            .lock()
            .expect("session summaries mutex should not be poisoned")
            .retain(|s| !ids.contains(&s.id));
    }

    /// Replace all summaries with a new list (used for seeding from runtime).
    #[allow(dead_code)]
    pub fn seed_summaries(&self, summaries: Vec<ProxySessionSummary>) {
        let mut guard = self
            .summaries
            .lock()
            .expect("session summaries mutex should not be poisoned");
        *guard = summaries;
    }

    /// Clear all summaries and return the IDs that were removed.
    pub fn clear_summaries(&self) -> Vec<String> {
        let mut summaries = self
            .summaries
            .lock()
            .expect("session summaries mutex should not be poisoned");
        let ids: Vec<String> = summaries.iter().map(|s| s.id.clone()).collect();
        summaries.clear();
        ids
    }

    /// Keep only the summary with the given id, return removed ids.
    pub fn retain_summaries(&self, keep_id: &str) -> Vec<String> {
        let mut summaries = self
            .summaries
            .lock()
            .expect("session summaries mutex should not be poisoned");
        let ids: Vec<String> = summaries
            .iter()
            .filter(|s| s.id != keep_id)
            .map(|s| s.id.clone())
            .collect();
        summaries.retain(|s| s.id == keep_id);
        ids
    }

    /// Number of cached summaries.
    pub fn summary_count(&self) -> usize {
        self.summaries
            .lock()
            .expect("session summaries mutex should not be poisoned")
            .len()
    }

    // ── detail LRU ──────────────────────────────────────────────────

    /// Try to get a cached detail. Returns `None` on miss (caller should
    /// fall back to DB).
    pub fn try_get_detail(&self, session_id: &str) -> Option<ProxySessionDetail> {
        let mut state = self
            .details
            .lock()
            .expect("session detail mutex should not be poisoned");
        let detail = state.map.get(session_id).cloned();
        if detail.is_some() {
            // Touch the LRU order inside the same lock acquisition so the
            // map and order can't desynchronize (M7).
            if let Some(idx) = state.order.iter().position(|id| id == session_id) {
                state.order.remove(idx);
            }
            state.order.push_back(session_id.to_string());
        }
        detail
    }

    /// Insert a detail into the LRU, evicting oldest entries if at capacity.
    /// Returns the IDs of evicted entries.
    pub fn insert_detail(&self, session_id: String, detail: ProxySessionDetail) -> Vec<String> {
        let mut state = self
            .details
            .lock()
            .expect("session detail mutex should not be poisoned");

        state.map.insert(session_id.clone(), detail);

        if let Some(idx) = state.order.iter().position(|id| id == &session_id) {
            state.order.remove(idx);
        }
        state.order.push_back(session_id);

        let mut evicted = Vec::new();
        while state.order.len() > SESSION_DETAIL_CACHE_CAPACITY {
            if let Some(evicted_id) = state.order.pop_front() {
                state.map.remove(&evicted_id);
                evicted.push(evicted_id);
            }
        }

        evicted
    }

    /// If a detail for this session is already cached, replace it with the given
    /// (fresh) detail so a viewer does not keep reading a stale snapshot — for
    /// example one captured while the request was still in flight, before the
    /// response body arrived. Does NOT insert a new entry: details still enter
    /// the LRU only when explicitly viewed, so completing a session the user
    /// never opened does not pollute or thrash the cache.
    pub fn refresh_detail_if_cached(&self, session_id: &str, detail: ProxySessionDetail) {
        let mut state = self
            .details
            .lock()
            .expect("session detail mutex should not be poisoned");
        if state.map.contains_key(session_id) {
            state.map.insert(session_id.to_string(), detail);
        }
    }

    /// Remove specific detail entries.
    pub fn remove_details(&self, ids: &HashSet<String>) {
        let mut state = self
            .details
            .lock()
            .expect("session detail mutex should not be poisoned");
        for id in ids {
            state.map.remove(id);
        }
        state.order.retain(|id| !ids.contains(id));
    }

    /// Clear all details (summaries are kept).
    #[allow(dead_code)] // only exercised by integration tests currently
    pub fn clear_details(&self) {
        let mut state = self
            .details
            .lock()
            .expect("session detail mutex should not be poisoned");
        state.map.clear();
        state.order.clear();
    }
}

impl Default for SessionCache {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for SessionCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionCache")
            .field("summary_count", &self.summary_count())
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn select_eviction_index(
    summaries: &[ProxySessionSummary],
    focused_hosts: &HashSet<String>,
) -> usize {
    if focused_hosts.is_empty() {
        return 0;
    }
    summaries
        .iter()
        .position(|s| !focused_hosts.contains(s.host.as_str()))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiproxy_proxy_core::{ProxyBodyReference, ProxySessionDetail, ProxySessionSummary};
    use std::collections::HashSet;

    fn build_summary(id: &str, host: &str) -> ProxySessionSummary {
        ProxySessionSummary {
            id: id.to_string(),
            method: "GET".to_string(),
            host: host.to_string(),
            path: "/".to_string(),
            protocol: "HTTP/1.1".to_string(),
            scheme: "https".to_string(),
            http_version: "1.1".to_string(),
            transport_protocol: "tcp".to_string(),
            application_protocol: "http".to_string(),
            started_at: "2026-04-15T00:00:00Z".to_string(),
            finished_at: "2026-04-15T00:00:01Z".to_string(),
            duration_ms: 1,
            size_bytes: 1,
            status_code: 200,
            url: format!("https://{host}/"),
            response_mime_type: Some("application/json".to_string()),
        }
    }

    fn build_focused_hosts(hosts: &[&str]) -> HashSet<String> {
        hosts.iter().map(|h| h.to_string()).collect()
    }

    fn build_detail(
        summary: &ProxySessionSummary,
        response_body: Option<ProxyBodyReference>,
    ) -> ProxySessionDetail {
        ProxySessionDetail {
            client_address: Some("127.0.0.1:54321".to_string()),
            id: summary.id.clone(),
            query_params: Vec::new(),
            cookies: Vec::new(),
            raw_request_head: Some("GET / HTTP/1.1".to_string()),
            raw_response_head: Some("HTTP/1.1 200 OK".to_string()),
            request_body: None,
            request_headers: Vec::new(),
            response_body,
            response_headers: Vec::new(),
            map_traces: Vec::new(),
            rewrite_traces: Vec::new(),
            server_ip: Some("1.2.3.4".to_string()),
            script_traces: Vec::new(),
            summary: summary.clone(),
            throttle_traces: Vec::new(),
            tls_cipher_suite: Some("TLS_AES_128_GCM_SHA256".to_string()),
            tls_protocol: Some("TLSv1.3".to_string()),
            timing: None,
            timing_source: None,
            trailers: None,
            h2_stream_id: None,
        }
    }

    #[test]
    fn refresh_detail_if_cached_replaces_stale_snapshot() {
        // Reproduces the in-flight selection bug: a detail captured before the
        // response arrived (no response_body) is cached, then the session
        // completes and the cached snapshot must be refreshed in place.
        let cache = SessionCache::new();
        let summary = build_summary("1", "api.example.com");
        cache.insert_detail(summary.id.clone(), build_detail(&summary, None));
        assert!(cache
            .try_get_detail(&summary.id)
            .unwrap()
            .response_body
            .is_none());

        let fresh = build_detail(
            &summary,
            Some(ProxyBodyReference::from_decoded_bytes(
                b"{\"ok\":true}".to_vec(),
                Some("application/json".to_string()),
                11,
                false,
                true,
            )),
        );
        cache.refresh_detail_if_cached(&summary.id, fresh);

        let cached = cache.try_get_detail(&summary.id).unwrap();
        assert!(cached.response_body.is_some());
    }

    #[test]
    fn refresh_detail_if_cached_does_not_cache_unviewed_session() {
        // Completing a session the user never opened must not pollute the LRU.
        let cache = SessionCache::new();
        let summary = build_summary("1", "api.example.com");
        let fresh = build_detail(
            &summary,
            Some(ProxyBodyReference::from_decoded_bytes(
                b"{}".to_vec(),
                Some("application/json".to_string()),
                2,
                false,
                true,
            )),
        );

        cache.refresh_detail_if_cached(&summary.id, fresh);

        assert!(cache.try_get_detail(&summary.id).is_none());
    }

    #[test]
    fn evicts_oldest_unfocused_session_before_focused_one() {
        let sessions = vec![
            build_summary("1", "api.example.com"),
            build_summary("2", "static.example.com"),
            build_summary("3", "api.example.com"),
        ];
        let focused = build_focused_hosts(&["api.example.com"]);
        assert_eq!(select_eviction_index(&sessions, &focused), 1);
    }

    #[test]
    fn falls_back_to_oldest_when_all_focused() {
        let sessions = vec![
            build_summary("1", "api.example.com"),
            build_summary("2", "api.example.com"),
        ];
        let focused = build_focused_hosts(&["api.example.com"]);
        assert_eq!(select_eviction_index(&sessions, &focused), 0);
    }

    #[test]
    fn falls_back_to_oldest_when_no_focus() {
        let sessions = vec![
            build_summary("1", "api.example.com"),
            build_summary("2", "static.example.com"),
        ];
        let focused = HashSet::new();
        assert_eq!(select_eviction_index(&sessions, &focused), 0);
    }
}
