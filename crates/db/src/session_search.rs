use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::{params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};

use crate::sessions::{escape_like_pattern, SessionSummaryRow};
use crate::DbError;

pub const SESSION_SEARCH_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_SESSION_SEARCH_LIMIT: usize = 20;
pub const MAX_SESSION_SEARCH_LIMIT: usize = 100;

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
    started_at: String,
    id: String,
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
        conditions.push(format!(
            "(s.started_at < ?{index} OR (s.started_at = ?{index} AND s.id < ?{next}))",
            next = index + 1
        ));
        values.push(Value::Text(cursor.started_at));
        values.push(Value::Text(cursor.id));
        index += 2;
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
    let sql = format!(
        "SELECT s.id, s.method, s.host, s.path, s.protocol, s.scheme, s.http_version,
                s.transport_protocol, s.application_protocol, s.started_at, s.finished_at,
                s.duration_ms, s.size_bytes, s.status_code, s.url, s.response_mime_type
         FROM session_summaries s{join_clause}{where_clause}
         ORDER BY s.started_at DESC, s.id DESC
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
            .map(|row| encode_cursor(&row.started_at, &row.id))
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

fn encode_cursor(started_at: &str, id: &str) -> Result<String, DbError> {
    let payload = CursorPayload {
        version: SESSION_SEARCH_SCHEMA_VERSION,
        started_at: started_at.to_string(),
        id: id.to_string(),
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
}
