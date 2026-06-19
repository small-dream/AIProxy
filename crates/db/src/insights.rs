use rusqlite::Connection;

use crate::DbError;
use serde::Serialize;

// ---------------------------------------------------------------------------
// Insights result types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsResult {
    pub total_requests: i64,
    pub total_errors: i64,
    pub error_rate: f64,
    pub avg_duration_ms: f64,
    pub p50_duration_ms: f64,
    pub p95_duration_ms: f64,
    pub p99_duration_ms: f64,
    pub total_bytes: i64,
    pub by_host: Vec<HostInsight>,
    pub by_status_code: Vec<StatusCodeDistribution>,
    pub by_method: Vec<MethodDistribution>,
    pub slow_requests: Vec<SlowRequest>,
    pub largest_requests: Vec<SlowRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInsight {
    pub host: String,
    pub request_count: i64,
    pub error_count: i64,
    pub avg_duration_ms: f64,
    pub p95_duration_ms: f64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCodeDistribution {
    pub status_code: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodDistribution {
    pub method: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowRequest {
    pub session_id: String,
    pub url: String,
    pub method: String,
    pub status_code: i64,
    pub duration_ms: i64,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Default)]
pub struct InsightsFilter {
    pub excluded_hosts: Vec<String>,
    pub host_exact: Option<String>,
    pub session_ids: Vec<String>,
    pub host_keyword: Option<String>,
}

fn build_where(filter: &InsightsFilter) -> (String, Vec<rusqlite::types::Value>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();
    let mut param_idx = 1;

    if !filter.session_ids.is_empty() {
        let placeholders: Vec<String> = filter
            .session_ids
            .iter()
            .map(|_| {
                let p = format!("?{param_idx}");
                param_idx += 1;
                p
            })
            .collect();
        conditions.push(format!("id IN ({})", placeholders.join(", ")));
        for id in &filter.session_ids {
            params.push(rusqlite::types::Value::Text(id.clone()));
        }
    }

    if let Some(kw) = filter
        .host_keyword
        .as_ref()
        .map(|keyword| keyword.trim().to_lowercase())
        .filter(|keyword| !keyword.is_empty())
    {
        conditions.push(format!("LOWER(host) LIKE ?{param_idx}"));
        params.push(rusqlite::types::Value::Text(format!("%{kw}%")));
        param_idx += 1;
    }

    if let Some(host) = filter
        .host_exact
        .as_ref()
        .map(|host| host.trim().to_lowercase())
        .filter(|host| !host.is_empty())
    {
        conditions.push(format!("LOWER(host) = ?{param_idx}"));
        params.push(rusqlite::types::Value::Text(host));
        param_idx += 1;
    }

    let excluded_hosts: Vec<String> = filter
        .excluded_hosts
        .iter()
        .map(|host| host.trim().to_lowercase())
        .filter(|host| !host.is_empty())
        .collect();

    if !excluded_hosts.is_empty() {
        let placeholders: Vec<String> = excluded_hosts
            .iter()
            .map(|_| {
                let p = format!("?{param_idx}");
                param_idx += 1;
                p
            })
            .collect();
        conditions.push(format!("LOWER(host) NOT IN ({})", placeholders.join(", ")));
        for host in excluded_hosts {
            params.push(rusqlite::types::Value::Text(host));
        }
    }

    if conditions.is_empty() {
        (String::new(), params)
    } else {
        (format!(" WHERE {}", conditions.join(" AND ")), params)
    }
}

/// A positive host filter (exact host or host keyword) scopes the view to one or
/// a few hosts; in that case the slow/largest rankings show every matching
/// request instead of the top-20 overview cap.
fn is_host_scoped(filter: &InsightsFilter) -> bool {
    let host_exact_active = filter
        .host_exact
        .as_ref()
        .map(|host| !host.trim().is_empty())
        .unwrap_or(false);
    let host_keyword_active = filter
        .host_keyword
        .as_ref()
        .map(|keyword| !keyword.trim().is_empty())
        .unwrap_or(false);
    host_exact_active || host_keyword_active
}

// ---------------------------------------------------------------------------
// Aggregation query
// ---------------------------------------------------------------------------

/// Compute aggregated insights over all sessions in the database.
///
/// Returns zeroed defaults when the `session_summaries` table is empty.
pub fn compute_insights(
    conn: &Connection,
    filter: &InsightsFilter,
) -> Result<InsightsResult, DbError> {
    let (where_clause, where_params) = build_where(filter);
    let params = || -> Vec<rusqlite::types::Value> { where_params.clone() };
    let ranking_limit_clause = if is_host_scoped(filter) {
        String::new()
    } else {
        " LIMIT 20".to_string()
    };

    // --- Overview stats ---
    let query = format!(
        "SELECT COUNT(*),
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END),
                AVG(duration_ms),
                SUM(size_bytes)
         FROM session_summaries{where_clause}"
    );
    let (total_requests, total_errors, avg_duration_ms, total_bytes) = conn
        .query_row(&query, rusqlite::params_from_iter(params()), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<f64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|e| DbError::query("insights overview query", e))?;

    let total_errors = total_errors.unwrap_or(0);
    let avg_duration_ms = avg_duration_ms.unwrap_or(0.0);
    let total_bytes = total_bytes.unwrap_or(0);
    let error_rate = if total_requests > 0 {
        total_errors as f64 / total_requests as f64
    } else {
        0.0
    };

    // --- Percentiles (compute in Rust by sorting durations) ---
    let p50_duration_ms;
    let p95_duration_ms;
    let p99_duration_ms;

    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT duration_ms FROM session_summaries{where_clause} ORDER BY duration_ms"
            ))
            .map_err(|e| DbError::query("insights percentile prepare", e))?;

        let durations: Result<Vec<i64>, DbError> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| DbError::query("insights percentile query", e))?
            .map(|r| r.map_err(|e| DbError::query("decode insight row", e)))
            .collect();
        let durations = durations?;

        p50_duration_ms = percentile(&durations, 50);
        p95_duration_ms = percentile(&durations, 95);
        p99_duration_ms = percentile(&durations, 99);
    }

    // --- By host (top 50) ---
    let by_host = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT host,
                        COUNT(*) AS request_count,
                        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
                        AVG(duration_ms) AS avg_duration_ms,
                        SUM(size_bytes) AS total_bytes
                 FROM session_summaries{where_clause}
                 GROUP BY host
                 ORDER BY request_count DESC, host
                 LIMIT 50"
            ))
            .map_err(|e| DbError::query("insights by_host prepare", e))?;

        let host_rows: Result<Vec<HostInsightRaw>, DbError> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(HostInsightRaw {
                    host: row.get("host")?,
                    request_count: row.get("request_count")?,
                    error_count: row.get::<_, Option<i64>>("error_count")?.unwrap_or(0),
                    avg_duration_ms: row.get::<_, Option<f64>>("avg_duration_ms")?.unwrap_or(0.0),
                    total_bytes: row.get::<_, Option<i64>>("total_bytes")?.unwrap_or(0),
                })
            })
            .map_err(|e| DbError::query("insights by_host query", e))?
            .map(|r| r.map_err(|e| DbError::query("decode insight row", e)))
            .collect();
        let host_rows = host_rows?;

        // Compute per-host P95
        let mut result = Vec::with_capacity(host_rows.len());
        for hr in &host_rows {
            let p95 = compute_host_p95(conn, &hr.host, filter)?;
            result.push(HostInsight {
                host: hr.host.clone(),
                request_count: hr.request_count,
                error_count: hr.error_count,
                avg_duration_ms: hr.avg_duration_ms,
                p95_duration_ms: p95,
                total_bytes: hr.total_bytes,
            });
        }
        result
    };

    // --- By status code ---
    let by_status_code: Vec<StatusCodeDistribution> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT status_code, COUNT(*) AS count
                 FROM session_summaries{where_clause}
                 GROUP BY status_code
                 HAVING status_code > 0
                 ORDER BY count DESC, status_code"
            ))
            .map_err(|e| DbError::query("insights by_status_code prepare", e))?;

        let rows: Result<Vec<StatusCodeDistribution>, DbError> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(StatusCodeDistribution {
                    status_code: row.get("status_code")?,
                    count: row.get("count")?,
                })
            })
            .map_err(|e| DbError::query("insights by_status_code query", e))?
            .map(|r| r.map_err(|e| DbError::query("decode insight row", e)))
            .collect();
        rows?
    };

    // --- By method ---
    let by_method: Vec<MethodDistribution> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT method, COUNT(*) AS count
                 FROM session_summaries{where_clause}
                 GROUP BY method
                 ORDER BY count DESC, method"
            ))
            .map_err(|e| DbError::query("insights by_method prepare", e))?;

        let rows: Result<Vec<MethodDistribution>, DbError> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(MethodDistribution {
                    method: row.get("method")?,
                    count: row.get("count")?,
                })
            })
            .map_err(|e| DbError::query("insights by_method query", e))?
            .map(|r| r.map_err(|e| DbError::query("decode insight row", e)))
            .collect();
        rows?
    };

    // --- Slow requests (top 20) ---
    let slow_requests: Vec<SlowRequest> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, url, method, status_code, duration_ms, size_bytes
                 FROM session_summaries{where_clause}
                 ORDER BY duration_ms DESC, started_at DESC, id{ranking_limit_clause}"
            ))
            .map_err(|e| DbError::query("insights slow_requests prepare", e))?;

        let rows: Result<Vec<SlowRequest>, DbError> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(SlowRequest {
                    session_id: row.get("id")?,
                    url: row.get("url")?,
                    method: row.get("method")?,
                    status_code: row.get("status_code")?,
                    duration_ms: row.get("duration_ms")?,
                    size_bytes: row.get("size_bytes")?,
                })
            })
            .map_err(|e| DbError::query("insights slow_requests query", e))?
            .map(|r| r.map_err(|e| DbError::query("decode insight row", e)))
            .collect();
        rows?
    };

    // --- Largest requests (top 20) ---
    let largest_requests: Vec<SlowRequest> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, url, method, status_code, duration_ms, size_bytes
                 FROM session_summaries{where_clause}
                 ORDER BY size_bytes DESC, started_at DESC, id{ranking_limit_clause}"
            ))
            .map_err(|e| DbError::query("insights largest_requests prepare", e))?;

        let rows: Result<Vec<SlowRequest>, DbError> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(SlowRequest {
                    session_id: row.get("id")?,
                    url: row.get("url")?,
                    method: row.get("method")?,
                    status_code: row.get("status_code")?,
                    duration_ms: row.get("duration_ms")?,
                    size_bytes: row.get("size_bytes")?,
                })
            })
            .map_err(|e| DbError::query("insights largest_requests query", e))?
            .map(|r| r.map_err(|e| DbError::query("decode insight row", e)))
            .collect();
        rows?
    };

    Ok(InsightsResult {
        total_requests,
        total_errors,
        error_rate,
        avg_duration_ms,
        p50_duration_ms,
        p95_duration_ms,
        p99_duration_ms,
        total_bytes,
        by_host,
        by_status_code,
        by_method,
        slow_requests,
        largest_requests,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct HostInsightRaw {
    host: String,
    request_count: i64,
    error_count: i64,
    avg_duration_ms: f64,
    total_bytes: i64,
}

/// Compute the P95 duration for a single host.
fn compute_host_p95(
    conn: &Connection,
    host: &str,
    filter: &InsightsFilter,
) -> Result<f64, DbError> {
    let (where_clause, mut where_params) = build_where(filter);
    let host_param_idx = where_params.len() + 1;
    let query = format!(
        "SELECT duration_ms FROM session_summaries{where_clause}{}LOWER(host) = ?{host_param_idx} ORDER BY duration_ms",
        if where_clause.is_empty() { " WHERE " } else { " AND " }
    );
    where_params.push(rusqlite::types::Value::Text(host.to_lowercase()));

    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| DbError::query("prepare host p95 query", e))?;

    let durations: Result<Vec<i64>, DbError> = stmt
        .query_map(rusqlite::params_from_iter(where_params), |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| DbError::query("query host p95", e))?
        .map(|r| r.map_err(|e| DbError::query("decode host p95 row", e)))
        .collect();
    let durations = durations?;

    Ok(percentile(&durations, 95))
}

/// Nearest-rank percentile. Returns 0.0 for empty slices.
fn percentile(sorted: &[i64], p: u8) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = (p as f64 / 100.0 * (sorted.len() - 1) as f64).round() as usize;
    sorted[rank.min(sorted.len() - 1)] as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::run_migrations(&conn).unwrap();
        conn
    }

    fn insert_session(
        conn: &Connection,
        id: &str,
        host: &str,
        method: &str,
        status_code: i32,
        duration_ms: i64,
        size_bytes: i64,
    ) {
        let url = format!("https://{host}/");
        conn.execute(
            "INSERT INTO session_summaries
                (id, method, host, path, protocol, scheme, http_version,
                 transport_protocol, application_protocol, started_at, finished_at,
                 duration_ms, size_bytes, status_code, url)
             VALUES (?1, ?2, ?3, '/', 'HTTP/1.1', 'https', '1.1', 'tcp', 'http',
                     '2026-05-25T00:00:00Z', '2026-05-25T00:00:01Z', ?4, ?5, ?6, ?7)",
            params![id, method, host, duration_ms, size_bytes, status_code, url],
        )
        .unwrap();
    }

    // Like `insert_session` but with an explicit `started_at`, so tiebreak
    // ordering (started_at DESC, id ASC) can be exercised in tests.
    fn insert_session_started_at(
        conn: &Connection,
        id: &str,
        host: &str,
        method: &str,
        status_code: i32,
        duration_ms: i64,
        size_bytes: i64,
        started_at: &str,
    ) {
        let url = format!("https://{host}/");
        conn.execute(
            "INSERT INTO session_summaries
                (id, method, host, path, protocol, scheme, http_version,
                 transport_protocol, application_protocol, started_at, finished_at,
                 duration_ms, size_bytes, status_code, url)
             VALUES (?1, ?2, ?3, '/', 'HTTP/1.1', 'https', '1.1', 'tcp', 'http',
                     ?8, '2026-05-25T00:00:01Z', ?4, ?5, ?6, ?7)",
            params![id, method, host, duration_ms, size_bytes, status_code, url, started_at],
        )
        .unwrap();
    }

    #[test]
    fn empty_table_returns_zeros() {
        let conn = test_conn();
        let result = compute_insights(&conn, &InsightsFilter::default()).unwrap();

        assert_eq!(result.total_requests, 0);
        assert_eq!(result.total_errors, 0);
        assert_eq!(result.error_rate, 0.0);
        assert_eq!(result.avg_duration_ms, 0.0);
        assert_eq!(result.p50_duration_ms, 0.0);
        assert_eq!(result.p95_duration_ms, 0.0);
        assert_eq!(result.p99_duration_ms, 0.0);
        assert_eq!(result.total_bytes, 0);
        assert!(result.by_host.is_empty());
        assert!(result.by_status_code.is_empty());
        assert!(result.by_method.is_empty());
        assert!(result.slow_requests.is_empty());
        assert!(result.largest_requests.is_empty());
    }

    #[test]
    fn aggregates_basic_stats() {
        let conn = test_conn();
        insert_session(&conn, "s1", "api.example.com", "GET", 200, 100, 500);
        insert_session(&conn, "s2", "api.example.com", "POST", 500, 200, 1000);
        insert_session(&conn, "s3", "cdn.example.com", "GET", 200, 50, 200);

        let result = compute_insights(&conn, &InsightsFilter::default()).unwrap();

        assert_eq!(result.total_requests, 3);
        assert_eq!(result.total_errors, 1);
        assert!((result.error_rate - 1.0 / 3.0).abs() < 1e-9);
        assert!((result.avg_duration_ms - 116.666_666_666_666_67).abs() < 1e-9);
        assert_eq!(result.total_bytes, 1700);
        assert_eq!(result.by_host.len(), 2);
        assert_eq!(result.by_host[0].host, "api.example.com");
        assert_eq!(result.by_host[0].request_count, 2);
        assert_eq!(result.by_host[0].error_count, 1);
        assert_eq!(result.by_status_code.len(), 2);
        assert_eq!(result.by_method.len(), 2);
        assert_eq!(result.slow_requests.len(), 3);
        assert_eq!(result.slow_requests[0].session_id, "s2"); // highest duration
        assert_eq!(result.slow_requests[0].size_bytes, 1000);
        assert_eq!(result.largest_requests.len(), 3);
        assert_eq!(result.largest_requests[0].session_id, "s2"); // largest size
        assert_eq!(result.largest_requests[0].size_bytes, 1000);
    }

    // Rankings only sort on their primary key (duration / size / count). Without
    // a deterministic tiebreaker, SQLite returns tied rows in an undefined order
    // that also differs from the frontend stable sort — so the view would reorder
    // tied rows whenever it flips between the backend and frontend paths. These
    // tests pin the shared tiebreaker rule (started_at DESC, then id ASC for the
    // request lists; the natural key ASC for the distributions).
    #[test]
    fn slow_requests_tiebreak_follows_started_at_then_id() {
        let conn = test_conn();
        // Identical duration: order is started_at DESC.
        insert_session_started_at(&conn, "a", "h.com", "GET", 200, 100, 10, "2026-05-25T00:00:01Z");
        insert_session_started_at(&conn, "b", "h.com", "GET", 200, 100, 10, "2026-05-25T00:00:03Z");
        insert_session_started_at(&conn, "c", "h.com", "GET", 200, 100, 10, "2026-05-25T00:00:02Z");

        let result = compute_insights(&conn, &InsightsFilter::default()).unwrap();
        let ids: Vec<&str> = result.slow_requests.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
    }

    #[test]
    fn slow_requests_tiebreak_falls_back_to_id_when_started_at_equal() {
        let conn = test_conn();
        insert_session_started_at(&conn, "x2", "h.com", "GET", 200, 100, 10, "2026-05-25T00:00:00Z");
        insert_session_started_at(&conn, "x1", "h.com", "GET", 200, 100, 10, "2026-05-25T00:00:00Z");

        let result = compute_insights(&conn, &InsightsFilter::default()).unwrap();
        let ids: Vec<&str> = result.slow_requests.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["x1", "x2"]); // id ASC
    }

    #[test]
    fn largest_requests_tiebreak_follows_started_at() {
        let conn = test_conn();
        insert_session_started_at(&conn, "a", "h.com", "GET", 200, 10, 500, "2026-05-25T00:00:01Z");
        insert_session_started_at(&conn, "b", "h.com", "GET", 200, 10, 500, "2026-05-25T00:00:03Z");

        let result = compute_insights(&conn, &InsightsFilter::default()).unwrap();
        let ids: Vec<&str> = result.largest_requests.iter().map(|r| r.session_id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]); // size_bytes tie -> started_at DESC
    }

    #[test]
    fn by_host_tiebreak_by_host_name() {
        let conn = test_conn();
        // One request per host -> equal request_count -> host ASC.
        insert_session(&conn, "1", "zebra.com", "GET", 200, 10, 10);
        insert_session(&conn, "2", "alpha.com", "GET", 200, 10, 10);
        insert_session(&conn, "3", "mango.com", "GET", 200, 10, 10);

        let result = compute_insights(&conn, &InsightsFilter::default()).unwrap();
        let hosts: Vec<&str> = result.by_host.iter().map(|h| h.host.as_str()).collect();
        assert_eq!(hosts, vec!["alpha.com", "mango.com", "zebra.com"]);
    }

    #[test]
    fn distributions_tiebreak_by_key() {
        let conn = test_conn();
        // Each status code / method appears once -> count tie -> key ASC.
        insert_session(&conn, "1", "h.com", "DELETE", 500, 10, 10);
        insert_session(&conn, "2", "h.com", "GET", 200, 10, 10);

        let result = compute_insights(&conn, &InsightsFilter::default()).unwrap();
        let codes: Vec<i64> = result.by_status_code.iter().map(|s| s.status_code).collect();
        assert_eq!(codes, vec![200, 500]);

        let methods: Vec<String> = result.by_method.iter().map(|m| m.method.clone()).collect();
        assert_eq!(methods, vec!["DELETE", "GET"]);
    }

    #[test]
    fn pending_request_excluded_from_status_distribution() {
        let conn = test_conn();
        insert_session(&conn, "d1", "api.example.com", "GET", 200, 100, 500);
        insert_session(&conn, "d2", "api.example.com", "GET", 0, 100, 500);

        let result = compute_insights(&conn, &InsightsFilter::default()).unwrap();

        // The in-flight request (status 0) still counts toward volume...
        assert_eq!(result.total_requests, 2);
        // ...but status code 0 is not a real HTTP status, so it is excluded from
        // the status-code distribution, which only reflects completed responses.
        assert_eq!(result.by_status_code.len(), 1);
        assert_eq!(result.by_status_code[0].status_code, 200);
        assert_eq!(result.by_status_code[0].count, 1);
    }

    #[test]
    fn host_scoped_ranking_is_not_capped_at_twenty() {
        let conn = test_conn();
        for i in 0..25 {
            let n = i as i64 + 1;
            insert_session(
                &conn,
                &format!("h{i}"),
                "api.example.com",
                "GET",
                200,
                n * 10,
                n * 100,
            );
        }
        for i in 0..5 {
            insert_session(&conn, &format!("o{i}"), "other.example.com", "GET", 200, 10, 100);
        }

        // Unscoped overview: rankings are capped at 20.
        let unscoped = compute_insights(&conn, &InsightsFilter::default()).unwrap();
        assert_eq!(unscoped.slow_requests.len(), 20);
        assert_eq!(unscoped.largest_requests.len(), 20);

        // Scoped to a host (focused debugging): no cap, all 25 for that host.
        let scoped = compute_insights(
            &conn,
            &InsightsFilter {
                host_exact: Some("api.example.com".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(scoped.slow_requests.len(), 25);
        assert_eq!(scoped.largest_requests.len(), 25);
    }

    #[test]
    fn percentile_nearest_rank() {
        let conn = test_conn();
        // Insert 10 sessions with durations 10..=100
        for i in 0..10 {
            insert_session(
                &conn,
                &format!("p{i}"),
                "host.com",
                "GET",
                200,
                (i + 1) * 10,
                100,
            );
        }

        let result = compute_insights(&conn, &InsightsFilter::default()).unwrap();

        // 10 items: indices 0..9, values 10,20,..,100
        assert_eq!(result.p50_duration_ms, 60.0); // index 5
        assert_eq!(result.p95_duration_ms, 100.0); // index 9
        assert_eq!(result.p99_duration_ms, 100.0); // index 9
    }

    #[test]
    fn filter_by_session_ids() {
        let conn = test_conn();
        insert_session(&conn, "s1", "api.example.com", "GET", 200, 100, 500);
        insert_session(&conn, "s2", "api.example.com", "POST", 500, 200, 1000);
        insert_session(&conn, "s3", "cdn.example.com", "GET", 200, 50, 200);

        let filter = InsightsFilter {
            session_ids: vec!["s1".into(), "s3".into()],
            host_keyword: None,
            ..InsightsFilter::default()
        };
        let result = compute_insights(&conn, &filter).unwrap();

        assert_eq!(result.total_requests, 2);
        assert_eq!(result.total_errors, 0);
        assert_eq!(result.total_bytes, 700);
        assert_eq!(result.by_host.len(), 2);
    }

    #[test]
    fn filter_by_host_keyword() {
        let conn = test_conn();
        insert_session(&conn, "s1", "api.example.com", "GET", 200, 100, 500);
        insert_session(&conn, "s2", "api.example.com", "POST", 500, 200, 1000);
        insert_session(&conn, "s3", "cdn.example.com", "GET", 200, 50, 200);

        let filter = InsightsFilter {
            session_ids: vec![],
            host_keyword: Some("API".into()),
            ..InsightsFilter::default()
        };
        let result = compute_insights(&conn, &filter).unwrap();

        assert_eq!(result.total_requests, 2);
        assert_eq!(result.total_errors, 1);
    }

    #[test]
    fn filter_by_exact_and_excluded_hosts() {
        let conn = test_conn();
        insert_session(&conn, "s1", "api.example.com", "GET", 200, 100, 500);
        insert_session(&conn, "s2", "api.example.com", "POST", 500, 200, 1000);
        insert_session(&conn, "s3", "cdn.example.com", "GET", 200, 50, 200);

        let exact_filter = InsightsFilter {
            host_exact: Some("API.EXAMPLE.COM".into()),
            ..InsightsFilter::default()
        };
        let exact_result = compute_insights(&conn, &exact_filter).unwrap();

        assert_eq!(exact_result.total_requests, 2);
        assert_eq!(exact_result.by_host.len(), 1);
        assert_eq!(exact_result.by_host[0].host, "api.example.com");

        let excluded_filter = InsightsFilter {
            excluded_hosts: vec!["api.example.com".into()],
            ..InsightsFilter::default()
        };
        let excluded_result = compute_insights(&conn, &excluded_filter).unwrap();

        assert_eq!(excluded_result.total_requests, 1);
        assert_eq!(excluded_result.by_host[0].host, "cdn.example.com");
    }

    #[test]
    fn filter_by_both() {
        let conn = test_conn();
        insert_session(&conn, "s1", "api.example.com", "GET", 200, 100, 500);
        insert_session(&conn, "s2", "api.example.com", "POST", 500, 200, 1000);
        insert_session(&conn, "s3", "cdn.example.com", "GET", 200, 50, 200);

        let filter = InsightsFilter {
            session_ids: vec!["s1".into(), "s2".into()],
            host_keyword: Some("cdn".into()),
            ..InsightsFilter::default()
        };
        let result = compute_insights(&conn, &filter).unwrap();

        assert_eq!(result.total_requests, 0);
    }
}
