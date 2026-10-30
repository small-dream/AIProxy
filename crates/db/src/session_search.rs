use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::{params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

use crate::sessions::{escape_like_pattern, SessionSummaryRow};
use crate::DbError;

pub const SESSION_SEARCH_SCHEMA_VERSION: u32 = 2;
pub const DEFAULT_SESSION_SEARCH_LIMIT: usize = 20;
pub const MAX_SESSION_SEARCH_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SessionSortField {
    #[default]
    StartedAt,
    DurationMs,
    SizeBytes,
    StatusCode,
}

impl SessionSortField {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StartedAt => "startedAt",
            Self::DurationMs => "durationMs",
            Self::SizeBytes => "sizeBytes",
            Self::StatusCode => "statusCode",
        }
    }

    fn sql_column(self) -> Option<&'static str> {
        match self {
            Self::StartedAt => None,
            Self::DurationMs => Some("s.duration_ms"),
            Self::SizeBytes => Some("s.size_bytes"),
            Self::StatusCode => Some("s.status_code"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SortOrder {
    #[default]
    Desc,
    Asc,
}

impl SortOrder {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desc => "desc",
            Self::Asc => "asc",
        }
    }

    fn sql(self) -> &'static str {
        match self {
            Self::Desc => "DESC",
            Self::Asc => "ASC",
        }
    }

    fn comparison(self) -> &'static str {
        match self {
            Self::Desc => "<",
            Self::Asc => ">",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionSearchField {
    Url,
    Host,
    Path,
    Method,
    Headers,
    Query,
}

#[derive(Debug, Clone, Default)]
pub struct SessionSearchFilter {
    pub host: Option<String>,
    pub host_contains: Option<String>,
    pub path_contains: Option<String>,
    pub query_params: Vec<(String, String)>,
    pub method: Option<String>,
    pub status_min: Option<u16>,
    pub status_max: Option<u16>,
    pub protocol: Option<String>,
    pub mime: Option<String>,
    pub started_after: Option<String>,
    pub started_before: Option<String>,
    pub min_duration_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
    pub keyword: Option<String>,
    pub search_in: Vec<SessionSearchField>,
    pub sort_by: SessionSortField,
    pub sort_order: SortOrder,
    /// Match summaries inserted after this opaque SQLite rowid watermark.
    pub after_rowid: Option<i64>,
    /// Wait-for-traffic only counts rows whose capture has finished.
    pub completed_only: bool,
    /// Restrict results to sessions with a recorded failure.
    pub failed_only: bool,
    /// Exact failure category, for example connect_refused.
    pub failure_kind: Option<String>,
    /// Exact failure origin: client, proxy, or upstream.
    pub failure_origin: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchPage {
    pub items: Vec<SessionSummaryRow>,
    pub next_cursor: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorPayload {
    version: u32,
    sort_by: String,
    sort_order: String,
    started_at: String,
    id: String,
    sort_value: Option<i64>,
}

/// Search persisted session summaries with deterministic cursor pagination.
pub fn search_sessions(
    conn: &Connection,
    filter: &SessionSearchFilter,
    limit: usize,
    cursor: Option<&str>,
) -> Result<SessionSearchPage, DbError> {
    if let (Some(min), Some(max)) = (filter.status_min, filter.status_max) {
        if min > max {
            return Err(DbError::Validation(
                "statusMin must not be greater than statusMax".to_string(),
            ));
        }
    }
    if let (Some(min), Some(max)) = (filter.min_duration_ms, filter.max_duration_ms) {
        if min > max {
            return Err(DbError::Validation(
                "minDurationMs must not be greater than maxDurationMs".to_string(),
            ));
        }
    }

    let limit = limit.clamp(1, MAX_SESSION_SEARCH_LIMIT);
    let cursor = cursor.map(decode_cursor).transpose()?;
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    let mut index = 1usize;
    let mut needs_details_join = false;
    let failures_available =
        crate::connection::table_has_columns(
            conn,
            "session_summaries",
            &["failure_origin", "failure_kind"],
        )? && crate::connection::table_has_columns(conn, "session_details", &["failure_message"])?;

    if let Some(after_rowid) = filter.after_rowid {
        conditions.push(format!("s.rowid > ?{index}"));
        values.push(Value::Integer(after_rowid));
        index += 1;
    }

    if filter.completed_only {
        conditions.push(if failures_available {
            "s.finished_at <> '' AND (s.status_code <> 0 OR s.failure_kind IS NOT NULL)".to_string()
        } else {
            "s.finished_at <> '' AND s.status_code <> 0".to_string()
        });
    }

    if let Some(host) = filter
        .host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        conditions.push(format!("LOWER(s.host) = ?{index}"));
        values.push(Value::Text(host.to_lowercase()));
        index += 1;
    }

    if let Some(host_contains) = filter
        .host_contains
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        conditions.push(format!("LOWER(s.host) LIKE ?{index} ESCAPE '\\'"));
        values.push(Value::Text(format!(
            "%{}%",
            escape_like_pattern(&host_contains.to_lowercase())
        )));
        index += 1;
    }

    if let Some(path_contains) = filter
        .path_contains
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        conditions.push(format!("instr(s.path, ?{index}) > 0"));
        values.push(Value::Text(path_contains.to_string()));
        index += 1;
    }

    for (name, value) in &filter.query_params {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        needs_details_join = true;
        conditions.push(format!(
            "(json_valid(d.query_params) AND EXISTS (SELECT 1 FROM json_each(d.query_params) AS qp \
             WHERE json_extract(qp.value, '$.name') = ?{index} \
             AND json_extract(qp.value, '$.value') = ?{next}))",
            next = index + 1
        ));
        values.push(Value::Text(name.to_string()));
        values.push(Value::Text(value.clone()));
        index += 2;
    }

    if let Some(method) = filter
        .method
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        conditions.push(format!("UPPER(s.method) = ?{index}"));
        values.push(Value::Text(method.to_uppercase()));
        index += 1;
    }

    if let Some(status_min) = filter.status_min {
        conditions.push(format!("s.status_code >= ?{index}"));
        values.push(Value::Integer(i64::from(status_min)));
        index += 1;
    }

    if let Some(status_max) = filter.status_max {
        conditions.push(format!("s.status_code <= ?{index}"));
        values.push(Value::Integer(i64::from(status_max)));
        index += 1;
    }

    if let Some(protocol) = filter
        .protocol
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let protocol = protocol.to_lowercase();
        conditions.push(format!(
            "(LOWER(s.scheme) = ?{index} OR LOWER(s.protocol) = ?{index} OR LOWER(s.http_version) = ?{index})"
        ));
        values.push(Value::Text(protocol));
        index += 1;
    }

    if let Some(mime) = filter
        .mime
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        conditions.push(format!(
            "LOWER(COALESCE(s.response_mime_type, '')) LIKE ?{index} ESCAPE '\\'"
        ));
        values.push(Value::Text(format!(
            "%{}%",
            escape_like_pattern(&mime.to_lowercase())
        )));
        index += 1;
    }

    if let Some(started_after) = filter
        .started_after
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        conditions.push(format!("s.started_at >= ?{index}"));
        values.push(Value::Text(started_after.to_string()));
        index += 1;
    }

    if let Some(started_before) = filter
        .started_before
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        conditions.push(format!("s.started_at <= ?{index}"));
        values.push(Value::Text(started_before.to_string()));
        index += 1;
    }

    if let Some(min_duration_ms) = filter.min_duration_ms {
        conditions.push(format!("s.duration_ms >= ?{index}"));
        values.push(Value::Integer(
            i64::try_from(min_duration_ms).unwrap_or(i64::MAX),
        ));
        index += 1;
    }

    if let Some(max_duration_ms) = filter.max_duration_ms {
        conditions.push(format!("s.duration_ms <= ?{index}"));
        values.push(Value::Integer(
            i64::try_from(max_duration_ms).unwrap_or(i64::MAX),
        ));
        index += 1;
    }

    let wants_failure = filter.failed_only
        || filter
            .failure_kind
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || filter
            .failure_origin
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    if wants_failure && !failures_available {
        conditions.push("0".to_string());
    } else {
        if filter.failed_only {
            conditions.push("s.failure_kind IS NOT NULL".to_string());
        }

        if let Some(failure_kind) = filter
            .failure_kind
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            conditions.push(format!("s.failure_kind = ?{index}"));
            values.push(Value::Text(failure_kind.to_string()));
            index += 1;
        }

        if let Some(failure_origin) = filter
            .failure_origin
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            conditions.push(format!("s.failure_origin = ?{index}"));
            values.push(Value::Text(failure_origin.to_string()));
            index += 1;
        }
    }

    if let Some(keyword) = filter
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let keyword = format!("%{}%", escape_like_pattern(&keyword.to_lowercase()));
        let fields = if filter.search_in.is_empty() {
            vec![
                SessionSearchField::Url,
                SessionSearchField::Host,
                SessionSearchField::Path,
                SessionSearchField::Method,
            ]
        } else {
            filter.search_in.clone()
        };
        let mut clauses = Vec::new();
        for field in fields {
            let column = match field {
                SessionSearchField::Url => "LOWER(s.url)",
                SessionSearchField::Host => "LOWER(s.host)",
                SessionSearchField::Path => "LOWER(s.path)",
                SessionSearchField::Method => "LOWER(s.method)",
                SessionSearchField::Headers => {
                    needs_details_join = true;
                    "LOWER(d.request_headers || ' ' || d.response_headers)"
                }
                SessionSearchField::Query => {
                    needs_details_join = true;
                    "LOWER(d.query_params)"
                }
            };
            clauses.push(format!("{column} LIKE ?{index} ESCAPE '\\'"));
            values.push(Value::Text(keyword.clone()));
            index += 1;
        }
        conditions.push(format!("({})", clauses.join(" OR ")));
    }

    if let Some(cursor) = cursor {
        if cursor.sort_by != filter.sort_by.as_str()
            || cursor.sort_order != filter.sort_order.as_str()
        {
            return Err(DbError::Validation(
                "cursor does not match the requested sort order".to_string(),
            ));
        }
        let comparison = filter.sort_order.comparison();
        if let Some(column) = filter.sort_by.sql_column() {
            let sort_value = cursor.sort_value.ok_or_else(|| {
                DbError::Validation("cursor is missing its sort value".to_string())
            })?;
            conditions.push(format!(
                "({column} {comparison} ?{index} OR \
                 ({column} = ?{index} AND \
                  (s.started_at {comparison} ?{started} OR \
                   (s.started_at = ?{started} AND s.id {comparison} ?{id}))))",
                started = index + 1,
                id = index + 2
            ));
            values.push(Value::Integer(sort_value));
            values.push(Value::Text(cursor.started_at));
            values.push(Value::Text(cursor.id));
            index += 3;
        } else {
            conditions.push(format!(
                "(s.started_at {comparison} ?{index} OR \
                 (s.started_at = ?{index} AND s.id {comparison} ?{next}))",
                next = index + 1
            ));
            values.push(Value::Text(cursor.started_at));
            values.push(Value::Text(cursor.id));
            index += 2;
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let join_clause = if needs_details_join {
        " LEFT JOIN session_details d ON d.session_summary_id = s.id"
    } else {
        ""
    };
    let order_clause = match filter.sort_by.sql_column() {
        Some(column) => format!(
            "{column} {}, s.started_at {}, s.id {}",
            filter.sort_order.sql(),
            filter.sort_order.sql(),
            filter.sort_order.sql()
        ),
        None => format!(
            "s.started_at {}, s.id {}",
            filter.sort_order.sql(),
            filter.sort_order.sql()
        ),
    };
    let failure_columns = if failures_available {
        "s.failure_origin, s.failure_kind,
         (SELECT d.failure_message FROM session_details d
          WHERE d.session_summary_id = s.id) AS failure_message"
    } else {
        "NULL AS failure_origin, NULL AS failure_kind, NULL AS failure_message"
    };
    let sql = format!(
        "SELECT s.id, s.method, s.host, s.path, s.protocol, s.scheme, s.http_version,
                s.transport_protocol, s.application_protocol, s.started_at, s.finished_at,
                s.duration_ms, s.size_bytes, s.status_code, s.url, s.response_mime_type,
                {failure_columns}
         FROM session_summaries s{join_clause}{where_clause}
         ORDER BY {order_clause}
         LIMIT ?{index}"
    );
    values.push(Value::Integer((limit + 1) as i64));

    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| DbError::query("prepare session search", error))?;
    let rows: Result<Vec<SessionSummaryRow>, DbError> = statement
        .query_map(params_from_iter(values), row_to_summary)
        .map_err(|error| DbError::query("query session search", error))?
        .map(|row| row.map_err(|error| DbError::query("decode session search row", error)))
        .collect();
    let mut rows = rows?;

    let truncated = rows.len() > limit;
    if truncated {
        rows.truncate(limit);
    }
    let next_cursor = if truncated {
        rows.last()
            .map(|row| encode_cursor(row, filter.sort_by, filter.sort_order))
            .transpose()?
    } else {
        None
    };

    Ok(SessionSearchPage {
        items: rows,
        next_cursor,
        truncated,
    })
}

/// Return the newest rowid for a completed session. `session_summaries` has
/// TEXT PRIMARY KEY without `WITHOUT ROWID`, and updates preserve rowid, so
/// this is a stable insertion-order watermark.
pub fn latest_completed_session_rowid(conn: &Connection) -> Result<i64, DbError> {
    let failure_columns =
        crate::connection::table_has_columns(
            conn,
            "session_summaries",
            &["failure_origin", "failure_kind"],
        )? && crate::connection::table_has_columns(conn, "session_details", &["failure_message"])?;
    let sql = if failure_columns {
        "SELECT COALESCE(MAX(rowid), 0) FROM session_summaries
         WHERE finished_at <> '' AND (status_code <> 0 OR failure_kind IS NOT NULL)"
    } else {
        "SELECT COALESCE(MAX(rowid), 0) FROM session_summaries
         WHERE finished_at <> '' AND status_code <> 0"
    };
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
        .map_err(|error| DbError::query("read session watermark", error))
}

fn encode_cursor(
    row: &SessionSummaryRow,
    sort_by: SessionSortField,
    sort_order: SortOrder,
) -> Result<String, DbError> {
    let payload = CursorPayload {
        version: SESSION_SEARCH_SCHEMA_VERSION,
        sort_by: sort_by.as_str().to_string(),
        sort_order: sort_order.as_str().to_string(),
        started_at: row.started_at.clone(),
        id: row.id.clone(),
        sort_value: match sort_by {
            SessionSortField::StartedAt => None,
            SessionSortField::DurationMs => {
                Some(i64::try_from(row.duration_ms).unwrap_or(i64::MAX))
            }
            SessionSortField::SizeBytes => Some(i64::try_from(row.size_bytes).unwrap_or(i64::MAX)),
            SessionSortField::StatusCode => Some(i64::from(row.status_code)),
        },
    };
    let json = serde_json::to_vec(&payload)
        .map_err(|error| DbError::Validation(format!("encode cursor: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(json))
}

fn decode_cursor(cursor: &str) -> Result<CursorPayload, DbError> {
    if cursor.len() > 1024 {
        return Err(DbError::Validation("invalid cursor".to_string()));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| DbError::Validation("invalid cursor".to_string()))?;
    let payload: CursorPayload = serde_json::from_slice(&bytes)
        .map_err(|_| DbError::Validation("invalid cursor".to_string()))?;
    if payload.version != SESSION_SEARCH_SCHEMA_VERSION
        || payload.started_at.trim().is_empty()
        || payload.id.trim().is_empty()
        || payload.id.len() > 256
        || !matches!(
            payload.sort_by.as_str(),
            "startedAt" | "durationMs" | "sizeBytes" | "statusCode"
        )
        || !matches!(payload.sort_order.as_str(), "asc" | "desc")
        || (payload.sort_by == "startedAt" && payload.sort_value.is_some())
        || (payload.sort_by != "startedAt" && payload.sort_value.is_none())
    {
        return Err(DbError::Validation("invalid cursor".to_string()));
    }
    Ok(payload)
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
        duration_ms: row.get::<_, i64>("duration_ms")?.max(0) as u128,
        size_bytes: row.get::<_, i64>("size_bytes")?.max(0) as usize,
        status_code: row.get::<_, i32>("status_code")?.clamp(0, 65535) as u16,
        url: row.get("url")?,
        response_mime_type: row.get("response_mime_type")?,
        failure_origin: row.get("failure_origin")?,
        failure_kind: row.get("failure_kind")?,
        failure_message: row.get("failure_message")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::open_in_memory;

    fn insert_session(conn: &Connection, id: &str, host: &str, started_at: &str, status: u16) {
        conn.execute(
            "INSERT INTO session_summaries
                (id, method, host, path, protocol, scheme, http_version,
                 transport_protocol, application_protocol, started_at, finished_at,
                 duration_ms, size_bytes, status_code, url)
             VALUES (?1, 'GET', ?2, '/login', 'HTTP/2', 'https', '2', 'tcp', 'http',
                     ?3, ?3, 120, 10, ?4, ?5)",
            rusqlite::params![
                id,
                host,
                started_at,
                status,
                format!("https://{host}/login")
            ],
        )
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_session_full(
        conn: &Connection,
        id: &str,
        path: &str,
        started_at: &str,
        status: u16,
        duration_ms: i64,
        size_bytes: i64,
        query_params: &str,
    ) {
        conn.execute(
            "INSERT INTO session_summaries
                (id, method, host, path, protocol, scheme, http_version,
                 transport_protocol, application_protocol, started_at, finished_at,
                 duration_ms, size_bytes, status_code, url)
             VALUES (?1, 'POST', 'api.example.com', ?2, 'HTTP/2', 'https', '2', 'tcp', 'http',
                     ?3, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                id,
                path,
                started_at,
                duration_ms,
                size_bytes,
                status,
                format!("https://api.example.com{path}")
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_details (id, session_summary_id, query_params)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![format!("{id}-detail"), id, query_params],
        )
        .unwrap();
    }

    #[test]
    fn cursor_pagination_is_stable_for_equal_timestamps() {
        let conn = open_in_memory().unwrap();
        insert_session(&conn, "b", "api.example.com", "2026-10-17T10:00:00Z", 200);
        insert_session(&conn, "a", "api.example.com", "2026-10-17T10:00:00Z", 200);
        insert_session(&conn, "c", "api.example.com", "2026-10-17T09:00:00Z", 500);

        let first = search_sessions(&conn, &SessionSearchFilter::default(), 2, None).unwrap();
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.items[0].id, "b");
        assert_eq!(first.items[1].id, "a");
        let cursor = first.next_cursor.unwrap();

        let second =
            search_sessions(&conn, &SessionSearchFilter::default(), 2, Some(&cursor)).unwrap();
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].id, "c");
        assert!(!second.truncated);
    }

    #[test]
    fn filters_status_and_host_contains() {
        let conn = open_in_memory().unwrap();
        insert_session(&conn, "s1", "api.example.com", "2026-10-17T10:00:00Z", 200);
        insert_session(&conn, "s2", "cdn.example.com", "2026-10-17T11:00:00Z", 500);
        let page = search_sessions(
            &conn,
            &SessionSearchFilter {
                host_contains: Some("api".into()),
                status_min: Some(400),
                ..SessionSearchFilter::default()
            },
            20,
            None,
        )
        .unwrap();
        assert!(page.items.is_empty());
    }

    #[test]
    fn invalid_cursor_is_rejected() {
        let conn = open_in_memory().unwrap();
        let err =
            search_sessions(&conn, &SessionSearchFilter::default(), 20, Some("bad")).unwrap_err();
        assert!(matches!(err, DbError::Validation(_)));
    }

    #[test]
    fn filters_by_path_and_query_params() {
        let conn = open_in_memory().unwrap();
        insert_session_full(
            &conn,
            "s1",
            "/v1/app.launch",
            "2026-10-17T10:00:00Z",
            200,
            100,
            10,
            r#"[{"name":"_method","value":"app.launch"}]"#,
        );
        insert_session_full(
            &conn,
            "s2",
            "/v1/other",
            "2026-10-17T10:01:00Z",
            200,
            100,
            10,
            r#"[{"name":"_method","value":"app.launch"}]"#,
        );

        let page = search_sessions(
            &conn,
            &SessionSearchFilter {
                path_contains: Some("app.launch".into()),
                query_params: vec![("_method".into(), "app.launch".into())],
                ..SessionSearchFilter::default()
            },
            20,
            None,
        )
        .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "s1");
    }

    #[test]
    fn malformed_query_details_are_skipped_without_failing_the_search() {
        let conn = open_in_memory().unwrap();
        insert_session_full(
            &conn,
            "broken",
            "/v1/broken",
            "2026-10-17T10:00:00Z",
            200,
            100,
            10,
            "not-json",
        );
        insert_session_full(
            &conn,
            "valid",
            "/v1/valid",
            "2026-10-17T10:01:00Z",
            200,
            100,
            10,
            r#"[{"name":"token","value":"yes"}]"#,
        );

        let page = search_sessions(
            &conn,
            &SessionSearchFilter {
                query_params: vec![("token".into(), "yes".into())],
                ..SessionSearchFilter::default()
            },
            20,
            None,
        )
        .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "valid");
    }

    #[test]
    fn sorts_by_supported_fields() {
        let conn = open_in_memory().unwrap();
        insert_session_full(
            &conn,
            "s1",
            "/a",
            "2026-10-17T10:00:00Z",
            500,
            100,
            300,
            "[]",
        );
        insert_session_full(
            &conn,
            "s2",
            "/b",
            "2026-10-17T10:01:00Z",
            200,
            300,
            100,
            "[]",
        );
        insert_session_full(
            &conn,
            "s3",
            "/c",
            "2026-10-17T10:02:00Z",
            400,
            200,
            200,
            "[]",
        );

        let ids = |sort_by, sort_order| {
            search_sessions(
                &conn,
                &SessionSearchFilter {
                    sort_by,
                    sort_order,
                    ..SessionSearchFilter::default()
                },
                20,
                None,
            )
            .unwrap()
            .items
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>()
        };

        assert_eq!(
            ids(SessionSortField::DurationMs, SortOrder::Desc),
            ["s2", "s3", "s1"]
        );
        assert_eq!(
            ids(SessionSortField::SizeBytes, SortOrder::Desc),
            ["s1", "s3", "s2"]
        );
        assert_eq!(
            ids(SessionSortField::StatusCode, SortOrder::Asc),
            ["s2", "s3", "s1"]
        );
    }

    #[test]
    fn sorted_cursor_pagination_is_stable_for_equal_values() {
        let conn = open_in_memory().unwrap();
        insert_session_full(
            &conn,
            "old",
            "/a",
            "2026-10-17T10:00:00Z",
            200,
            200,
            10,
            "[]",
        );
        insert_session_full(
            &conn,
            "new",
            "/b",
            "2026-10-17T10:02:00Z",
            200,
            200,
            10,
            "[]",
        );
        insert_session_full(
            &conn,
            "last",
            "/c",
            "2026-10-17T10:01:00Z",
            200,
            100,
            10,
            "[]",
        );
        let filter = SessionSearchFilter {
            sort_by: SessionSortField::DurationMs,
            sort_order: SortOrder::Desc,
            ..SessionSearchFilter::default()
        };

        let first = search_sessions(&conn, &filter, 2, None).unwrap();
        assert_eq!(
            first
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["new", "old"]
        );
        let cursor = first.next_cursor.unwrap();
        let second = search_sessions(&conn, &filter, 2, Some(&cursor)).unwrap();
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].id, "last");
        assert!(!second.truncated);
    }

    #[test]
    fn cursor_rejects_a_different_sort_request() {
        let conn = open_in_memory().unwrap();
        insert_session(&conn, "a", "api.example.com", "2026-10-17T10:00:00Z", 200);
        insert_session(&conn, "b", "api.example.com", "2026-10-17T09:00:00Z", 200);

        let first = search_sessions(&conn, &SessionSearchFilter::default(), 1, None).unwrap();
        let cursor = first.next_cursor.unwrap();
        let error = search_sessions(
            &conn,
            &SessionSearchFilter {
                sort_by: SessionSortField::DurationMs,
                ..SessionSearchFilter::default()
            },
            1,
            Some(&cursor),
        )
        .unwrap_err();
        assert!(matches!(error, DbError::Validation(_)));
    }
}
