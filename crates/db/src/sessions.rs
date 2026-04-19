use rusqlite::{params, Connection};

// ---------------------------------------------------------------------------
// Session summary row (list view)
// ---------------------------------------------------------------------------

pub struct SessionSummaryRow {
    pub id: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub protocol: String,
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
    pub query_params: String,      // JSON array
    pub cookies: String,           // JSON array
    pub request_headers: String,   // JSON array
    pub response_headers: String,  // JSON array
    pub raw_request: Option<String>,
    pub raw_response: Option<String>,
    pub server_ip: Option<String>,
    pub request_body_ref: Option<String>,  // nullable JSON
    pub response_body_ref: Option<String>, // nullable JSON
    pub timing: Option<String>,            // nullable JSON
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/// Insert or update a session (summary + detail) in a single transaction.
pub fn upsert_session(
    conn: &Connection,
    summary: &SessionSummaryRow,
    detail: &SessionDetailRow,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO session_summaries
            (id, method, host, path, protocol, started_at, finished_at,
             duration_ms, size_bytes, status_code, url, response_mime_type)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            summary.id, summary.method, summary.host, summary.path,
            summary.protocol, summary.started_at, summary.finished_at,
            summary.duration_ms as i64, summary.size_bytes as i64,
            summary.status_code as i32, summary.url, summary.response_mime_type,
        ],
    )
    .map_err(|e| format!("upsert session summary: {e}"))?;

    conn.execute(
        "INSERT OR REPLACE INTO session_details
            (id, session_summary_id, query_params, cookies,
             request_headers, response_headers, raw_request, raw_response,
             server_ip, request_body_ref, response_body_ref, timing)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            detail.id, detail.session_summary_id,
            detail.query_params, detail.cookies,
            detail.request_headers, detail.response_headers,
            detail.raw_request, detail.raw_response,
            detail.server_ip, detail.request_body_ref,
            detail.response_body_ref, detail.timing,
        ],
    )
    .map_err(|e| format!("upsert session detail: {e}"))?;

    Ok(())
}

/// Load recent session summaries, ordered by started_at descending, up to `limit`.
pub fn load_recent_summaries(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<SessionSummaryRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, method, host, path, protocol, started_at, finished_at,
                    duration_ms, size_bytes, status_code, url, response_mime_type
             FROM session_summaries
             ORDER BY started_at DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("prepare load summaries: {e}"))?;

    let rows = stmt
        .query_map(params![limit as i64], row_to_summary)
        .map_err(|e| format!("query summaries: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Load a single session detail by ID.
pub fn load_session_detail(conn: &Connection, id: &str) -> Result<Option<SessionDetailRow>, String> {
    let result = conn.query_row(
        "SELECT id, session_summary_id, query_params, cookies,
                request_headers, response_headers, raw_request, raw_response,
                server_ip, request_body_ref, response_body_ref, timing
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
                server_ip: row.get(8)?,
                request_body_ref: row.get(9)?,
                response_body_ref: row.get(10)?,
                timing: row.get(11)?,
            })
        },
    );

    match result {
        Ok(detail) => Ok(Some(detail)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("load session detail: {e}")),
    }
}

/// Delete sessions by ID list. Returns the number of deleted rows.
pub fn delete_sessions_by_ids(conn: &Connection, ids: &[String]) -> Result<usize, String> {
    if ids.is_empty() {
        return Ok(0);
    }

    let placeholders: Vec<String> = ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
    let sql = format!(
        "DELETE FROM session_summaries WHERE id IN ({})",
        placeholders.join(",")
    );

    let params: Vec<&dyn rusqlite::types::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
    let count = conn
        .execute(&sql, params.as_slice())
        .map_err(|e| format!("delete sessions: {e}"))?;

    Ok(count)
}

/// Delete all sessions (summaries cascade to details and ws_messages).
pub fn clear_all_sessions(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM session_details", [])
        .map_err(|e| format!("clear session details: {e}"))?;
    conn.execute("DELETE FROM ws_messages", [])
        .map_err(|e| format!("clear ws messages: {e}"))?;
    conn.execute("DELETE FROM session_summaries", [])
        .map_err(|e| format!("clear session summaries: {e}"))?;
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
pub fn insert_ws_message(conn: &Connection, msg: &WsMessageRow) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO ws_messages
            (id, session_id, direction, timestamp, opcode, payload_text, payload_size, fin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            msg.id, msg.session_id, msg.direction, msg.timestamp,
            msg.opcode, msg.payload_text, msg.payload_size as i64, msg.fin as i32,
        ],
    )
    .map_err(|e| format!("insert ws message: {e}"))?;
    Ok(())
}

/// Load WebSocket messages for a session, ordered by timestamp ascending.
pub fn load_ws_messages(
    conn: &Connection,
    session_id: &str,
    limit: usize,
    offset: usize,
) -> Result<Vec<WsMessageRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, direction, timestamp, opcode, payload_text, payload_size, fin
             FROM ws_messages
             WHERE session_id = ?1
             ORDER BY timestamp ASC
             LIMIT ?2 OFFSET ?3",
        )
        .map_err(|e| format!("prepare load ws messages: {e}"))?;

    let rows = stmt
        .query_map(params![session_id, limit as i64, offset as i64], row_to_ws_message)
        .map_err(|e| format!("query ws messages: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Count WebSocket messages for a session.
pub fn count_ws_messages(conn: &Connection, session_id: &str) -> Result<usize, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ws_messages WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("count ws messages: {e}"))?;
    Ok(count as usize)
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
            server_ip: Some("1.2.3.4".into()),
            request_body_ref: None,
            response_body_ref: None,
            timing: Some("{\"totalMs\":100}".into()),
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

        let loaded_detail = load_session_detail(&conn, "s1").unwrap().unwrap();
        assert_eq!(loaded_detail.server_ip, Some("1.2.3.4".into()));
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

    #[test]
    fn ws_message_round_trip() {
        let conn = test_conn();
        upsert_session(&conn, &test_summary("ws1", "ws.example.com"), &test_detail("ws1")).unwrap();

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
        upsert_session(&conn, &test_summary("ws2", "ws.example.com"), &test_detail("ws2")).unwrap();

        insert_ws_message(&conn, &WsMessageRow {
            id: "m1".into(),
            session_id: "ws2".into(),
            direction: "serverToClient".into(),
            timestamp: "2026-04-19T00:00:01Z".into(),
            opcode: "text".into(),
            payload_text: None,
            payload_size: 0,
            fin: true,
        }).unwrap();

        delete_sessions_by_ids(&conn, &["ws2".into()]).unwrap();
        let loaded = load_ws_messages(&conn, "ws2", 100, 0).unwrap();
        assert!(loaded.is_empty());
    }
}
