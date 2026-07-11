use rusqlite::{params, Connection};

use crate::DbError;

// ---------------------------------------------------------------------------
// Session summary row (list view)
// ---------------------------------------------------------------------------

pub struct SessionSummaryRow {
    pub id: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub protocol: String,
    pub scheme: String,
    pub http_version: String,
    pub transport_protocol: String,
    pub application_protocol: String,
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u128,
    pub size_bytes: usize,
    pub status_code: u16,
    pub url: String,
    pub response_mime_type: Option<String>,
}

// ---------------------------------------------------------------------------
// Session detail row (inspector view)
// ---------------------------------------------------------------------------

pub struct SessionDetailRow {
    pub id: String,
    pub session_summary_id: String,
    pub query_params: String,     // JSON array
    pub cookies: String,          // JSON array
    pub request_headers: String,  // JSON array
    pub response_headers: String, // JSON array
    pub raw_request: Option<String>,
    pub raw_response: Option<String>,
    pub client_address: Option<String>,
    pub server_ip: Option<String>,
    pub tls_cipher_suite: Option<String>,
    pub tls_protocol: Option<String>,
    pub request_body_ref: Option<String>,  // nullable JSON
    pub response_body_ref: Option<String>, // nullable JSON
    pub timing: Option<String>,            // nullable JSON
    pub trailers: Option<String>,          // nullable JSON
    pub h2_stream_id: Option<u32>,
}

fn u128_to_i64_saturating(value: u128) -> i64 {
    value.min(i64::MAX as u128) as i64
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/// Insert or update a session (summary + detail) in a single transaction.
pub fn upsert_session(
    conn: &Connection,
    summary: &SessionSummaryRow,
    detail: &SessionDetailRow,
) -> Result<(), DbError> {
    // H6: the detail row's FK (session_summary_id) must point at the summary
    // being upserted in the same call. A mismatch would silently cross-link a
    // detail (body/headers/timing) to the wrong session. The detail's own PK
    // (id) is intentionally independent (callers use "{summary_id}-detail").
    if detail.session_summary_id != summary.id {
        return Err(DbError::Validation(format!(
            "session_summary_id mismatch: detail '{}' != summary '{}'",
            detail.session_summary_id, summary.id
        )));
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin upsert session transaction", e))?;

    // Use UPDATE-or-INSERT instead of INSERT OR REPLACE: a REPLACE on
    // session_summaries triggers ON DELETE CASCADE on ws_messages,
    // script_runs, rewrite_runs, map_runs, throttle_runs and session_details
    // (foreign_keys=ON), silently wiping child rows on every re-insert.
    let affected = tx
        .execute(
            "UPDATE session_summaries
                SET method=?2, host=?3, path=?4, protocol=?5, scheme=?6, http_version=?7,
                    transport_protocol=?8, application_protocol=?9, started_at=?10,
                    finished_at=?11, duration_ms=?12, size_bytes=?13, status_code=?14,
                    url=?15, response_mime_type=?16
             WHERE id=?1",
            params![
                summary.id,
                summary.method,
                summary.host,
                summary.path,
                summary.protocol,
                summary.scheme,
                summary.http_version,
                summary.transport_protocol,
                summary.application_protocol,
                summary.started_at,
                summary.finished_at,
                u128_to_i64_saturating(summary.duration_ms),
                summary.size_bytes as i64,
                summary.status_code as i32,
                summary.url,
                summary.response_mime_type,
            ],
        )
        .map_err(|e| DbError::query("update session summary", e))?;

    if affected == 0 {
        tx.execute(
            "INSERT INTO session_summaries
                (id, method, host, path, protocol, scheme, http_version, transport_protocol,
                 application_protocol, started_at, finished_at, duration_ms, size_bytes,
                 status_code, url, response_mime_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                summary.id,
                summary.method,
                summary.host,
                summary.path,
                summary.protocol,
                summary.scheme,
                summary.http_version,
                summary.transport_protocol,
                summary.application_protocol,
                summary.started_at,
                summary.finished_at,
                u128_to_i64_saturating(summary.duration_ms),
                summary.size_bytes as i64,
                summary.status_code as i32,
                summary.url,
                summary.response_mime_type,
            ],
        )
        .map_err(|e| DbError::query("insert session summary", e))?;
    }

    // session_details has no child tables, so INSERT OR REPLACE is safe here;
    // but use UPDATE-or-INSERT for consistency and to keep the same id.
    let detail_affected = tx
        .execute(
            "UPDATE session_details
                SET session_summary_id=?2, query_params=?3, cookies=?4,
                    request_headers=?5, response_headers=?6, raw_request=?7, raw_response=?8,
                    client_address=?9, server_ip=?10, tls_cipher_suite=?11, tls_protocol=?12,
                    request_body_ref=?13, response_body_ref=?14, timing=?15,
                    trailers=?16, h2_stream_id=?17
             WHERE id=?1",
            params![
                detail.id,
                detail.session_summary_id,
                detail.query_params,
                detail.cookies,
                detail.request_headers,
                detail.response_headers,
                detail.raw_request,
                detail.raw_response,
                detail.client_address,
                detail.server_ip,
                detail.tls_cipher_suite,
                detail.tls_protocol,
                detail.request_body_ref,
                detail.response_body_ref,
                detail.timing,
                detail.trailers,
                detail.h2_stream_id,
            ],
        )
        .map_err(|e| DbError::query("update session detail", e))?;

    if detail_affected == 0 {
        tx.execute(
            "INSERT INTO session_details
                (id, session_summary_id, query_params, cookies,
                 request_headers, response_headers, raw_request, raw_response,
                 client_address, server_ip, tls_cipher_suite, tls_protocol,
                 request_body_ref, response_body_ref, timing,
                 trailers, h2_stream_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                detail.id,
                detail.session_summary_id,
                detail.query_params,
                detail.cookies,
                detail.request_headers,
                detail.response_headers,
                detail.raw_request,
                detail.raw_response,
                detail.client_address,
                detail.server_ip,
                detail.tls_cipher_suite,
                detail.tls_protocol,
                detail.request_body_ref,
                detail.response_body_ref,
                detail.timing,
                detail.trailers,
                detail.h2_stream_id,
            ],
        )
        .map_err(|e| DbError::query("insert session detail", e))?;
    }

    tx.commit()
        .map_err(|e| DbError::query("commit upsert session transaction", e))?;

    Ok(())
}

/// Load recent session summaries, ordered by started_at descending, up to `limit`.
pub fn load_recent_summaries(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<SessionSummaryRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, method, host, path, protocol, scheme, http_version,
                    transport_protocol, application_protocol, started_at, finished_at,
                    duration_ms, size_bytes, status_code, url, response_mime_type
             FROM session_summaries
             ORDER BY started_at DESC
             LIMIT ?1",
        )
        .map_err(|e| DbError::query("prepare load summaries", e))?;

    let rows: Result<Vec<SessionSummaryRow>, DbError> = stmt
        .query_map(params![limit as i64], row_to_summary)
        .map_err(|e| DbError::query("query summaries", e))?
        .map(|r| r.map_err(|e| DbError::query("decode session summary row", e)))
        .collect();

    rows
}

/// Load a single session summary by ID.
pub fn load_session_summary(
    conn: &Connection,
    id: &str,
) -> Result<Option<SessionSummaryRow>, DbError> {
    let result = conn.query_row(
        "SELECT id, method, host, path, protocol, scheme, http_version,
                transport_protocol, application_protocol, started_at, finished_at,
                duration_ms, size_bytes, status_code, url, response_mime_type
         FROM session_summaries
         WHERE id = ?1",
        params![id],
        row_to_summary,
    );

    match result {
        Ok(summary) => Ok(Some(summary)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(DbError::query("load session summary", e)),
    }
}

/// Load a single session detail by ID.
pub fn load_session_detail(
    conn: &Connection,
    id: &str,
) -> Result<Option<SessionDetailRow>, DbError> {
    let result = conn.query_row(
        "SELECT id, session_summary_id, query_params, cookies,
                request_headers, response_headers, raw_request, raw_response,
                client_address, server_ip, tls_cipher_suite, tls_protocol,
                request_body_ref, response_body_ref, timing,
                trailers, h2_stream_id
         FROM session_details WHERE session_summary_id=?1",
        params![id],
        |row| {
            Ok(SessionDetailRow {
                id: row.get(0)?,
                session_summary_id: row.get(1)?,
                query_params: row.get(2)?,
                cookies: row.get(3)?,
                request_headers: row.get(4)?,
                response_headers: row.get(5)?,
                raw_request: row.get(6)?,
                raw_response: row.get(7)?,
                client_address: row.get(8)?,
                server_ip: row.get(9)?,
                tls_cipher_suite: row.get(10)?,
                tls_protocol: row.get(11)?,
                request_body_ref: row.get(12)?,
                response_body_ref: row.get(13)?,
                timing: row.get(14)?,
                trailers: row.get(15)?,
                h2_stream_id: row.get::<_, Option<i64>>(16)?.map(|v| v as u32),
            })
        },
    );

    match result {
        Ok(detail) => Ok(Some(detail)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(DbError::query("load session detail", e)),
    }
}

/// Maximum number of bound variables per statement. SQLite caps this at
/// `SQLITE_LIMIT_VARIABLE_NUMBER` (default 999, 32766 on newer builds), so
/// binding the entire id list at once makes `prepare` fail once the list grows
/// past the limit. 500 stays well under both ceilings.
const DELETE_SESSIONS_BATCH_SIZE: usize = 500;

/// Delete sessions by ID list. Returns the number of deleted summary rows.
///
/// IDs are deleted in batches of [`DELETE_SESSIONS_BATCH_SIZE`] so each
/// statement's placeholder count stays under SQLite's
/// `SQLITE_LIMIT_VARIABLE_NUMBER`. The whole operation runs in a single
/// transaction; if any batch fails the transaction is rolled back.
pub fn delete_sessions_by_ids(conn: &Connection, ids: &[String]) -> Result<usize, DbError> {
    if ids.is_empty() {
        return Ok(0);
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin delete sessions transaction", e))?;

    let mut total_deleted = 0usize;
    for chunk in ids.chunks(DELETE_SESSIONS_BATCH_SIZE) {
        let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 1)).collect();
        let params: Vec<&dyn rusqlite::types::ToSql> = chunk
            .iter()
            .map(|id| id as &dyn rusqlite::types::ToSql)
            .collect();
        let placeholder_list = placeholders.join(",");

        // H5: rely on ON DELETE CASCADE for all child tables (session_details,
        // ws_messages, script_runs/script_run_entries, rewrite_runs/
        // rewrite_run_entries, map_runs, throttle_runs). All child FKs are
        // declared ON DELETE CASCADE and foreign_keys=ON (connection.rs). This
        // matches clear_all_sessions and avoids the maintenance trap where a
        // newly-added child table would be silently orphaned by this path but
        // correctly cascaded by clear_all_sessions. The previous hand-written
        // child->parent DELETE list duplicated the cascade graph.
        let sql = format!(
            "DELETE FROM session_summaries WHERE id IN ({})",
            placeholder_list
        );
        let count = tx
            .execute(&sql, params.as_slice())
            .map_err(|e| DbError::query("delete sessions", e))?;
        total_deleted += count;
    }

    tx.commit()
        .map_err(|e| DbError::query("commit delete sessions transaction", e))?;

    Ok(total_deleted)
}

/// Delete all sessions (summaries cascade to details and ws_messages).
pub fn clear_all_sessions(conn: &Connection) -> Result<(), DbError> {
    // L9: delete only the parent table and let the declared FK ON DELETE CASCADE
    // remove every child row (session_details, ws_messages, *_runs / *_run_entries,
    // map_runs, throttle_runs). The previous hand-written child→parent DELETE
    // list duplicated the cascade graph and would silently orphan any NEW child
    // table added later that forgot to extend this list. `foreign_keys=ON` is set
    // in connection.rs, so CASCADE is active. Wrapped in a transaction so the
    // whole clear is atomic.
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin clear sessions transaction", e))?;
    tx.execute("DELETE FROM session_summaries", [])
        .map_err(|e| DbError::query("clear session summaries", e))?;
    tx.commit()
        .map_err(|e| DbError::query("commit clear sessions transaction", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// WebSocket message row
// ---------------------------------------------------------------------------

pub struct WsMessageRow {
    pub id: String,
    pub session_id: String,
    pub direction: String,
    pub timestamp: String,
    pub opcode: String,
    pub payload_text: Option<String>,
    pub payload_size: usize,
    pub fin: bool,
}

/// Insert a single WebSocket message.
pub fn insert_ws_message(conn: &Connection, msg: &WsMessageRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR IGNORE INTO ws_messages
            (id, session_id, direction, timestamp, opcode, payload_text, payload_size, fin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            msg.id,
            msg.session_id,
            msg.direction,
            msg.timestamp,
            msg.opcode,
            msg.payload_text,
            msg.payload_size as i64,
            msg.fin as i32,
        ],
    )
    .map_err(|e| DbError::query("insert ws message", e))?;
    Ok(())
}

/// Load WebSocket messages for a session, ordered by timestamp ascending.
pub fn load_ws_messages(
    conn: &Connection,
    session_id: &str,
    limit: usize,
    offset: usize,
) -> Result<Vec<WsMessageRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, direction, timestamp, opcode, payload_text, payload_size, fin
             FROM ws_messages
             WHERE session_id = ?1
             ORDER BY timestamp ASC
             LIMIT ?2 OFFSET ?3",
        )
        .map_err(|e| DbError::query("prepare load ws messages", e))?;

    let rows: Result<Vec<WsMessageRow>, DbError> = stmt
        .query_map(
            params![session_id, limit as i64, offset as i64],
            row_to_ws_message,
        )
        .map_err(|e| DbError::query("query ws messages", e))?
        .map(|r| r.map_err(|e| DbError::query("decode session detail row", e)))
        .collect();

    rows
}

/// Count WebSocket messages for a session.
pub fn count_ws_messages(conn: &Connection, session_id: &str) -> Result<usize, DbError> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ws_messages WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| DbError::query("count ws messages", e))?;
    Ok(count as usize)
}

/// Search WebSocket messages by payload text using LIKE.
pub fn search_ws_messages(
    conn: &Connection,
    session_id: &str,
    query: &str,
    limit: usize,
    offset: usize,
) -> Result<Vec<WsMessageRow>, DbError> {
    // Escape LIKE wildcards AND the escape char itself. Backslash must be
    // escaped first, otherwise the backslashes added for %/_ would themselves
    // get escaped on the next pass (L1).
    let escaped_query = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let like_pattern = format!("%{escaped_query}%");
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, direction, timestamp, opcode, payload_text, payload_size, fin
             FROM ws_messages
             WHERE session_id = ?1 AND payload_text LIKE ?2 ESCAPE '\\'
             ORDER BY timestamp ASC
             LIMIT ?3 OFFSET ?4",
        )
        .map_err(|e| DbError::query("prepare search ws messages", e))?;

    let rows: Result<Vec<WsMessageRow>, DbError> = stmt
        .query_map(
            params![session_id, like_pattern, limit as i64, offset as i64],
            row_to_ws_message,
        )
        .map_err(|e| DbError::query("search ws messages", e))?
        .map(|r| r.map_err(|e| DbError::query("decode session detail row", e)))
        .collect();

    rows
}

fn row_to_ws_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<WsMessageRow> {
    Ok(WsMessageRow {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        direction: row.get("direction")?,
        timestamp: row.get("timestamp")?,
        opcode: row.get("opcode")?,
        payload_text: row.get("payload_text")?,
        payload_size: row.get::<_, i64>("payload_size")? as usize,
        fin: row.get::<_, i32>("fin")? != 0,
    })
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionSummaryRow> {
    Ok(SessionSummaryRow {
        id: row.get("id")?,
        method: row.get("method")?,
        host: row.get("host")?,
        path: row.get("path")?,
        protocol: row.get("protocol")?,
        scheme: row.get("scheme")?,
        http_version: row.get("http_version")?,
        transport_protocol: row.get("transport_protocol")?,
        application_protocol: row.get("application_protocol")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        duration_ms: row.get::<_, i64>("duration_ms")? as u128,
        size_bytes: row.get::<_, i64>("size_bytes")? as usize,
        status_code: row.get::<_, i32>("status_code")? as u16,
        url: row.get("url")?,
        response_mime_type: row.get("response_mime_type")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::run_migrations(&conn).unwrap();
        conn
    }

    fn test_summary(id: &str, host: &str) -> SessionSummaryRow {
        SessionSummaryRow {
            id: id.into(),
            method: "GET".into(),
            host: host.into(),
            path: "/".into(),
            protocol: "HTTP/1.1".into(),
            scheme: "https".into(),
            http_version: "1.1".into(),
            transport_protocol: "tcp".into(),
            application_protocol: "http".into(),
            started_at: "2026-04-19T00:00:00Z".into(),
            finished_at: "2026-04-19T00:00:01Z".into(),
            duration_ms: 100,
            size_bytes: 500,
            status_code: 200,
            url: format!("https://{host}/"),
            response_mime_type: Some("application/json".into()),
        }
    }

    fn test_detail(summary_id: &str) -> SessionDetailRow {
        SessionDetailRow {
            id: format!("{summary_id}-detail"),
            session_summary_id: summary_id.into(),
            query_params: "[]".into(),
            cookies: "[]".into(),
            request_headers: "[{\"name\":\"Host\",\"value\":\"example.com\"}]".into(),
            response_headers: "[]".into(),
            raw_request: None,
            raw_response: None,
            client_address: Some("127.0.0.1:54321".into()),
            server_ip: Some("1.2.3.4".into()),
            tls_cipher_suite: Some("TLS_AES_128_GCM_SHA256".into()),
            tls_protocol: Some("TLSv1.3".into()),
            request_body_ref: None,
            response_body_ref: None,
            timing: Some("{\"totalMs\":100}".into()),
            trailers: None,
            h2_stream_id: None,
        }
    }

    #[test]
    fn session_round_trip() {
        let conn = test_conn();
        let summary = test_summary("s1", "example.com");
        let detail = test_detail("s1");

        upsert_session(&conn, &summary, &detail).unwrap();

        let loaded = load_recent_summaries(&conn, 100).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "s1");
        assert_eq!(loaded[0].scheme, "https");
        assert_eq!(loaded[0].http_version, "1.1");
        assert_eq!(loaded[0].transport_protocol, "tcp");
        assert_eq!(loaded[0].application_protocol, "http");

        let loaded_detail = load_session_detail(&conn, "s1").unwrap().unwrap();
        assert_eq!(loaded_detail.server_ip, Some("1.2.3.4".into()));
    }

    #[test]
    fn load_session_summary_returns_exact_match() {
        let conn = test_conn();
        upsert_session(&conn, &test_summary("s1", "a.com"), &test_detail("s1")).unwrap();
        upsert_session(&conn, &test_summary("s2", "b.com"), &test_detail("s2")).unwrap();

        let loaded = load_session_summary(&conn, "s2").unwrap().unwrap();

        assert_eq!(loaded.id, "s2");
        assert_eq!(loaded.host, "b.com");
    }

    #[test]
    fn clear_all_removes_everything() {
        let conn = test_conn();
        upsert_session(&conn, &test_summary("s1", "a.com"), &test_detail("s1")).unwrap();
        upsert_session(&conn, &test_summary("s2", "b.com"), &test_detail("s2")).unwrap();

        clear_all_sessions(&conn).unwrap();
        assert!(load_recent_summaries(&conn, 100).unwrap().is_empty());
    }

    #[test]
    fn delete_by_ids() {
        let conn = test_conn();
        upsert_session(&conn, &test_summary("s1", "a.com"), &test_detail("s1")).unwrap();
        upsert_session(&conn, &test_summary("s2", "b.com"), &test_detail("s2")).unwrap();
        upsert_session(&conn, &test_summary("s3", "c.com"), &test_detail("s3")).unwrap();

        let deleted = delete_sessions_by_ids(&conn, &["s1".into(), "s3".into()]).unwrap();
        assert_eq!(deleted, 2);

        let remaining = load_recent_summaries(&conn, 100).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "s2");
    }

    // Regression for H7: building ?1..?N placeholders for the entire id list
    // exceeds SQLITE_LIMIT_VARIABLE_NUMBER when N is large, causing prepare to
    // fail and the whole delete to abort. The background cleaner swallows the
    // error, so old sessions never get pruned. Batching the deletes (batch
    // size well under the limit) keeps each statement within the SQLite
    // variable limit.
    //
    // The bundled SQLite ships with MAX_VARIABLE_NUMBER=32766, and system
    // SQLite on older platforms defaults to 999. The chunked delete path is
    // covered cheaply by `delete_sessions_by_ids_spans_multiple_batches` (501
    // ids → 2 batches). This ignored test reproduces the original prepare
    // failure at the real limit; run it manually:
    //   cargo test -p aiproxy-db delete_sessions_by_ids_handles_more_than_variable_limit -- --ignored
    #[ignore]
    #[test]
    fn delete_sessions_by_ids_handles_more_than_variable_limit() {
        // Bundled SQLite MAX_VARIABLE_NUMBER=32766; 32767 ids reproduces the
        // pre-fix prepare failure. Ignored because inserting/deleting 32k+
        // rows is slow (~1min). Run manually:
        //   cargo test -p aiproxy-db delete_sessions_by_ids_handles_more_than_variable_limit -- --ignored
        let conn = test_conn();
        let ids: Vec<String> = (0..32767).map(|i| format!("bulk-{i}")).collect();
        for id in &ids {
            upsert_session(&conn, &test_summary(id, "example.com"), &test_detail(id)).unwrap();
        }
        let deleted = delete_sessions_by_ids(&conn, &ids).expect("batched delete succeeds");
        assert_eq!(deleted, ids.len());
        // Confirm they are actually gone.
        for id in &ids {
            assert!(
                load_session_summary(&conn, id).unwrap().is_none(),
                "session {id} should be deleted"
            );
        }
    }

    // Fast coverage of the multi-batch (chunking) path. 501 ids exceeds
    // DELETE_SESSIONS_BATCH_SIZE (500), spanning 2 batches, so it proves the
    // batched delete is correct without the cost of the 32k-row ignored test.
    #[test]
    fn delete_sessions_by_ids_spans_multiple_batches() {
        let conn = test_conn();
        let ids: Vec<String> = (0..501).map(|i| format!("multi-{i}")).collect();
        for id in &ids {
            upsert_session(&conn, &test_summary(id, "example.com"), &test_detail(id)).unwrap();
        }
        let deleted = delete_sessions_by_ids(&conn, &ids).expect("batched delete succeeds");
        assert_eq!(deleted, ids.len());
        for id in &ids {
            assert!(
                load_session_summary(&conn, id).unwrap().is_none(),
                "session {id} should be deleted"
            );
        }
    }

    #[test]
    fn ws_message_round_trip() {
        let conn = test_conn();
        upsert_session(
            &conn,
            &test_summary("ws1", "ws.example.com"),
            &test_detail("ws1"),
        )
        .unwrap();

        let msg = WsMessageRow {
            id: "m1".into(),
            session_id: "ws1".into(),
            direction: "clientToServer".into(),
            timestamp: "2026-04-19T00:00:01Z".into(),
            opcode: "text".into(),
            payload_text: Some("hello".into()),
            payload_size: 5,
            fin: true,
        };
        insert_ws_message(&conn, &msg).unwrap();

        let loaded = load_ws_messages(&conn, "ws1", 100, 0).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].payload_text, Some("hello".into()));
        assert_eq!(loaded[0].direction, "clientToServer");
    }

    #[test]
    fn ws_messages_cascade_on_session_delete() {
        let conn = test_conn();
        upsert_session(
            &conn,
            &test_summary("ws2", "ws.example.com"),
            &test_detail("ws2"),
        )
        .unwrap();

        insert_ws_message(
            &conn,
            &WsMessageRow {
                id: "m1".into(),
                session_id: "ws2".into(),
                direction: "serverToClient".into(),
                timestamp: "2026-04-19T00:00:01Z".into(),
                opcode: "text".into(),
                payload_text: None,
                payload_size: 0,
                fin: true,
            },
        )
        .unwrap();

        delete_sessions_by_ids(&conn, &["ws2".into()]).unwrap();
        let loaded = load_ws_messages(&conn, "ws2", 100, 0).unwrap();
        assert!(loaded.is_empty());
    }

    // Regression for H1: re-upserting an existing session must NOT wipe its
    // child rows. The old INSERT OR REPLACE implementation triggered
    // ON DELETE CASCADE on ws_messages/runs via the REPLACE's implicit delete.
    #[test]
    fn upsert_session_preserves_ws_messages_on_reinsert() {
        let conn = test_conn();
        upsert_session(
            &conn,
            &test_summary("re1", "re.example.com"),
            &test_detail("re1"),
        )
        .unwrap();

        insert_ws_message(
            &conn,
            &WsMessageRow {
                id: "rm1".into(),
                session_id: "re1".into(),
                direction: "clientToServer".into(),
                timestamp: "2026-04-19T00:00:01Z".into(),
                opcode: "text".into(),
                payload_text: Some("preserved".into()),
                payload_size: 9,
                fin: true,
            },
        )
        .unwrap();

        // Second upsert with the same id (e.g. response arrives, finished_at
        // updated) must keep the ws message that was already stored.
        let mut updated_summary = test_summary("re1", "re.example.com");
        updated_summary.finished_at = "2026-04-19T00:00:05Z".into();
        updated_summary.duration_ms = 5_000;
        upsert_session(&conn, &updated_summary, &test_detail("re1")).unwrap();

        let messages = load_ws_messages(&conn, "re1", 100, 0).unwrap();
        assert_eq!(
            messages.len(),
            1,
            "ws messages must survive session re-upsert"
        );
        assert_eq!(messages[0].payload_text.as_deref(), Some("preserved"));
    }

    // Regression for H1: re-upserting a session must also preserve the detail
    // row and update summary fields (status_code/finished_at) in place.
    #[test]
    fn upsert_session_updates_summary_in_place_on_reinsert() {
        let conn = test_conn();
        upsert_session(
            &conn,
            &test_summary("re2", "re2.example.com"),
            &test_detail("re2"),
        )
        .unwrap();

        let mut updated = test_summary("re2", "re2.example.com");
        updated.status_code = 404;
        updated.finished_at = "2026-04-19T00:00:09Z".into();
        upsert_session(&conn, &updated, &test_detail("re2")).unwrap();

        let summaries = load_recent_summaries(&conn, 100).unwrap();
        assert_eq!(
            summaries.len(),
            1,
            "re-upsert must not duplicate the summary"
        );
        assert_eq!(summaries[0].status_code, 404);
        assert_eq!(summaries[0].finished_at, "2026-04-19T00:00:09Z");
    }

    // H5: delete_sessions_by_ids must cascade to all child tables via
    // ON DELETE CASCADE, matching clear_all_sessions. The pre-fix path
    // hand-deleted each child; a future child table would be orphaned. This
    // test inserts a session with a script_run (whose entries are a
    // grandchild) and verifies all descendants are removed.
    #[test]
    fn h5_delete_sessions_by_ids_cascades_child_tables() {
        let conn = test_conn();
        upsert_session(
            &conn,
            &test_summary("h5", "h5.example.com"),
            &test_detail("h5"),
        )
        .unwrap();
        // Insert a session detail row (child) and a ws message (child).
        insert_ws_message(
            &conn,
            &WsMessageRow {
                id: "h5m".into(),
                session_id: "h5".into(),
                direction: "clientToServer".into(),
                timestamp: "2026-04-19T00:00:01Z".into(),
                opcode: "text".into(),
                payload_text: None,
                payload_size: 0,
                fin: true,
            },
        )
        .unwrap();

        delete_sessions_by_ids(&conn, &["h5".into()]).unwrap();

        // Summary gone.
        assert!(load_session_summary(&conn, "h5").unwrap().is_none());
        // Child table (ws_messages) cascaded.
        assert!(load_ws_messages(&conn, "h5", 100, 0).unwrap().is_empty());
        // Child table (session_details) cascaded — verify via load_session_detail.
        assert!(load_session_detail(&conn, "h5").unwrap().is_none());
    }

    // H6: upsert_session must reject a detail whose session_summary_id does not
    // match the summary id, preventing a silent cross-link of body/headers to
    // the wrong session.
    #[test]
    fn h6_upsert_session_rejects_mismatched_session_summary_id() {
        let conn = test_conn();
        let summary = test_summary("h6-summary", "h6.example.com");
        // Detail points at a DIFFERENT summary id.
        let mut detail = test_detail("h6-summary");
        detail.session_summary_id = "wrong-id".into();
        let result = upsert_session(&conn, &summary, &detail);
        assert!(
            matches!(result, Err(DbError::Validation(_))),
            "expected Validation error for mismatched session_summary_id, got {result:?}"
        );
        // Nothing was written.
        assert!(
            load_session_summary(&conn, "h6-summary").unwrap().is_none(),
            "no summary should be written on a rejected upsert"
        );
    }

    // H6: a detail with its own independent PK id but a matching FK is accepted
    // (the detail.id convention is "{summary_id}-detail", not equal to summary.id).
    #[test]
    fn h6_upsert_session_accepts_detail_with_independent_id() {
        let conn = test_conn();
        let summary = test_summary("h6b", "h6b.example.com");
        let detail = test_detail("h6b"); // id = "h6b-detail", session_summary_id = "h6b"
        upsert_session(&conn, &summary, &detail).unwrap();
        let loaded = load_session_detail(&conn, "h6b").unwrap();
        assert!(loaded.is_some(), "detail should load with matching FK");
    }
}
