use rusqlite::Connection;
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
}

#[derive(Debug, Clone, Default)]
pub struct InsightsFilter {
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

    if let Some(ref keyword) = filter.host_keyword {
        let kw = keyword.to_lowercase();
        conditions.push(format!("LOWER(host) LIKE ?{param_idx}"));
        params.push(rusqlite::types::Value::Text(format!("%{kw}%")));
    }

    if conditions.is_empty() {
        (String::new(), params)
    } else {
        (format!(" WHERE {}", conditions.join(" AND ")), params)
    }
}

// ---------------------------------------------------------------------------
// Aggregation query
// ---------------------------------------------------------------------------

/// Compute aggregated insights over all sessions in the database.
///
/// Returns zeroed defaults when the `session_summaries` table is empty.
pub fn compute_insights(conn: &Connection, filter: &InsightsFilter) -> Result<InsightsResult, String> {
    let (where_clause, where_params) = build_where(filter);
    let params = || -> Vec<rusqlite::types::Value> { where_params.clone() };

    // --- Overview stats ---
    let query = format!(
        "SELECT COUNT(*),
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END),
                AVG(duration_ms),
                SUM(size_bytes)
         FROM session_summaries{where_clause}"
    );
    let (total_requests, total_errors, avg_duration_ms, total_bytes) = conn
        .query_row(
            &query,
            rusqlite::params_from_iter(params()),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .map_err(|e| format!("insights overview query: {e}"))?;

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
            .prepare(&format!("SELECT duration_ms FROM session_summaries{where_clause} ORDER BY duration_ms"))
            .map_err(|e| format!("insights percentile prepare: {e}"))?;

        let durations: Vec<i64> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| row.get::<_, i64>(0))
            .map_err(|e| format!("insights percentile query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

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
                 ORDER BY request_count DESC
                 LIMIT 50"
            ))
            .map_err(|e| format!("insights by_host prepare: {e}"))?;

        let host_rows: Vec<HostInsightRaw> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(HostInsightRaw {
                    host: row.get("host")?,
                    request_count: row.get("request_count")?,
                    error_count: row.get::<_, Option<i64>>("error_count")?.unwrap_or(0),
                    avg_duration_ms: row.get::<_, Option<f64>>("avg_duration_ms")?.unwrap_or(0.0),
                    total_bytes: row.get::<_, Option<i64>>("total_bytes")?.unwrap_or(0),
                })
            })
            .map_err(|e| format!("insights by_host query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        // Compute per-host P95
        let mut result = Vec::with_capacity(host_rows.len());
        for hr in &host_rows {
            let p95 = compute_host_p95(conn, &hr.host, filter);
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
                 ORDER BY count DESC"
            ))
            .map_err(|e| format!("insights by_status_code prepare: {e}"))?;

        let rows: Vec<StatusCodeDistribution> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(StatusCodeDistribution {
                    status_code: row.get("status_code")?,
                    count: row.get("count")?,
                })
            })
            .map_err(|e| format!("insights by_status_code query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    // --- By method ---
    let by_method: Vec<MethodDistribution> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT method, COUNT(*) AS count
                 FROM session_summaries{where_clause}
                 GROUP BY method
                 ORDER BY count DESC"
            ))
            .map_err(|e| format!("insights by_method prepare: {e}"))?;

        let rows: Vec<MethodDistribution> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(MethodDistribution {
                    method: row.get("method")?,
                    count: row.get("count")?,
                })
            })
            .map_err(|e| format!("insights by_method query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    // --- Slow requests (top 20) ---
    let slow_requests: Vec<SlowRequest> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, url, method, status_code, duration_ms
                 FROM session_summaries{where_clause}
                 ORDER BY duration_ms DESC
                 LIMIT 20"
            ))
            .map_err(|e| format!("insights slow_requests prepare: {e}"))?;

        let rows: Vec<SlowRequest> = stmt
            .query_map(rusqlite::params_from_iter(params()), |row| {
                Ok(SlowRequest {
                    session_id: row.get("id")?,
                    url: row.get("url")?,
                    method: row.get("method")?,
                    status_code: row.get("status_code")?,
                    duration_ms: row.get("duration_ms")?,
                })
            })
            .map_err(|e| format!("insights slow_requests query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        rows
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
) -> f64 {
    let (where_clause, mut where_params) = build_where(filter);
    let host_param_idx = where_params.len() + 1;
    let query = format!(
        "SELECT duration_ms FROM session_summaries{where_clause}{}LOWER(host) = ?{host_param_idx} ORDER BY duration_ms",
        if where_clause.is_empty() { " WHERE " } else { " AND " }
    );
    where_params.push(rusqlite::types::Value::Text(host.to_lowercase()));

    let mut stmt = match conn.prepare(&query) {
        Ok(s) => s,
        Err(_) => return 0.0,
    };

    let result = stmt.query_map(rusqlite::params_from_iter(where_params), |row| row.get::<_, i64>(0));
    let durations: Vec<i64> = match result {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => return 0.0,
    };

    percentile(&durations, 95)
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
        };
        let result = compute_insights(&conn, &filter).unwrap();

        assert_eq!(result.total_requests, 2);
        assert_eq!(result.total_errors, 1);
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
        };
        let result = compute_insights(&conn, &filter).unwrap();

        assert_eq!(result.total_requests, 0);
    }
}
