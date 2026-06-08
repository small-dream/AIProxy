use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use aiproxy_proxy_core::{ProxySessionDetail, ProxySessionSummary};

const SESSION_DETAIL_CACHE_CAPACITY: usize = 1_000;
const SESSION_SUMMARY_MAX: usize = 15_000;

/// In-memory cache for session summaries and a bounded LRU for session details.
///
/// Separated from `AppState` so that cache policies and eviction are testable
/// in isolation, and so that `AppState` focuses on coordination (persistence,
/// events, status).
pub(crate) struct SessionCache {
    details: Mutex<HashMap<String, ProxySessionDetail>>,
    detail_order: Mutex<VecDeque<String>>,
    summaries: Mutex<Vec<ProxySessionSummary>>,
}

impl SessionCache {
    pub fn new() -> Self {
        Self {
            details: Mutex::new(HashMap::new()),
            detail_order: Mutex::new(VecDeque::new()),
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
        let detail = self
            .details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .get(session_id)
            .cloned();
        if detail.is_some() {
            self.touch_detail_order(session_id);
        }
        detail
    }

    /// Insert a detail into the LRU, evicting oldest entries if at capacity.
    /// Returns the IDs of evicted entries.
    pub fn insert_detail(&self, session_id: String, detail: ProxySessionDetail) -> Vec<String> {
        self.details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .insert(session_id.clone(), detail);

        let mut order = self
            .detail_order
            .lock()
            .expect("session detail order mutex should not be poisoned");
        if let Some(idx) = order.iter().position(|id| id == &session_id) {
            order.remove(idx);
        }
        order.push_back(session_id.clone());

        let mut evicted = Vec::new();
        while order.len() > SESSION_DETAIL_CACHE_CAPACITY {
            if let Some(evicted_id) = order.pop_front() {
                evicted.push(evicted_id);
            }
        }
        drop(order);

        if !evicted.is_empty() {
            let mut details = self
                .details
                .lock()
                .expect("session detail mutex should not be poisoned");
            for id in &evicted {
                details.remove(id);
            }
        }

        evicted
    }

    /// Remove specific detail entries.
    pub fn remove_details(&self, ids: &HashSet<String>) {
        let mut details = self
            .details
            .lock()
            .expect("session detail mutex should not be poisoned");
        for id in ids {
            details.remove(id);
        }
        self.detail_order
            .lock()
            .expect("session detail order mutex should not be poisoned")
            .retain(|id| !ids.contains(id));
    }

    /// Clear all details (summaries are kept).
    #[allow(dead_code)] // only exercised by integration tests currently
    pub fn clear_details(&self) {
        self.details
            .lock()
            .expect("session detail mutex should not be poisoned")
            .clear();
        self.detail_order
            .lock()
            .expect("session detail order mutex should not be poisoned")
            .clear();
    }

    fn touch_detail_order(&self, session_id: &str) {
        let mut order = self
            .detail_order
            .lock()
            .expect("session detail order mutex should not be poisoned");
        if let Some(idx) = order.iter().position(|id| id == session_id) {
            order.remove(idx);
        }
        order.push_back(session_id.to_string());
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
    use aiproxy_proxy_core::ProxySessionSummary;
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
