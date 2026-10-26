use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;

use aiproxy_db::sessions::{
    insert_ws_message, upsert_session, SessionDetailRow, SessionSummaryRow, WsMessageRow,
};
use aiproxy_mcp::config::{
    write_config, AgentAccessConfig, AgentAccessLimits, AgentAccessPermissions,
    AgentAccessRedaction, AppPaths,
};
use aiproxy_mcp::protocol::MCP_TOOL_SCHEMA_VERSION;
use aiproxy_mcp::tools::body::{
    get_session_body, get_session_fields, BodyPart, BodyRedactionMode, GetSessionBodyRequest,
    GetSessionFieldsRequest,
};
use aiproxy_mcp::tools::compare::{compare_sessions, CompareSessionsRequest, DiffMode};
use aiproxy_mcp::tools::insights::{get_insights, GetInsightsRequest, GroupBy};
use aiproxy_mcp::tools::sessions::{
    get_session, search, GetSessionRequest, RedactionMode, SearchSessionsRequest, SessionInclude,
};
use aiproxy_mcp::tools::websocket::{get_messages, GetWebSocketMessagesRequest};
use aiproxy_mcp::AppContext;
use serde_json::{json, Value};

fn temp_data_dir(name: &str) -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!("aiproxy_mcp_test_{name}_{unique}"));
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

fn create_fixture(name: &str) -> (PathBuf, AppContext) {
    let directory = temp_data_dir(name);
    let db_path = directory.join("aiproxy.db");
    let connection = aiproxy_db::rusqlite::Connection::open(&db_path).unwrap();
    aiproxy_db::schema::run_migrations(&connection).unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();

    for (id, message, status) in [("left", "hello", 200), ("right", "world", 500)] {
        let summary = SessionSummaryRow {
            id: id.to_string(),
            method: "POST".to_string(),
            host: "api.example.com".to_string(),
            path: "/v1/chat".to_string(),
            protocol: "HTTP/2".to_string(),
            scheme: "https".to_string(),
            http_version: "2".to_string(),
            transport_protocol: "tcp".to_string(),
            application_protocol: "http".to_string(),
            started_at: format!("2026-10-17T10:00:0{}Z", if id == "left" { 0 } else { 1 }),
            finished_at: format!("2026-10-17T10:00:0{}Z", if id == "left" { 1 } else { 2 }),
            duration_ms: if id == "left" { 120 } else { 480 },
            size_bytes: 20,
            status_code: status,
            url: "https://api.example.com/v1/chat?token=secret".to_string(),
            response_mime_type: Some("application/json".to_string()),
        };
        let body = format!(
            "{{\"token\":\"secret-{id}\",\"message\":\"{message}\",\"ab\":{{\"ab_test\":\"{}\"}},\"payload\":\"{} filler\"}}",
            if id == "left" { "A" } else { "B" },
            "x".repeat(400)
        );
        let body_ref = json!({
            "file_path": null,
            "inline_text": body,
            "base64_text": null,
            "mime_type": "application/json",
            "encoding": null,
            "size_bytes": if id == "left" { body.len() / 2 } else { body.len() },
            "truncated": false,
        });
        let detail = SessionDetailRow {
            id: format!("{id}-detail"),
            session_summary_id: id.to_string(),
            query_params: json!([{ "name": "token", "value": "secret-query" }]).to_string(),
            cookies: json!([{ "name": "session", "value": "cookie-secret" }]).to_string(),
            request_headers: json!([
                { "name": "Authorization", "value": "Bearer secret-token" },
                { "name": "Content-Type", "value": "application/json" }
            ])
            .to_string(),
            response_headers: json!([
                { "name": "Set-Cookie", "value": "session=secret" },
                { "name": "Content-Type", "value": "application/json" }
            ])
            .to_string(),
            raw_request: None,
            raw_response: None,
            client_address: None,
            server_ip: None,
            tls_cipher_suite: Some("TLS_AES_128_GCM_SHA256".to_string()),
            tls_protocol: Some("TLSv1.3".to_string()),
            request_body_ref: None,
            response_body_ref: Some(body_ref.to_string()),
            timing: Some(json!({ "dnsMs": 1, "ttfbMs": 80 }).to_string()),
            trailers: None,
            h2_stream_id: Some(1),
            via_upstream_proxy: Some(false),
        };
        upsert_session(&connection, &summary, &detail).unwrap();
    }

    for (id, text) in [("wm-1", "hello socket"), ("wm-2", "world socket")] {
        insert_ws_message(
            &connection,
            &WsMessageRow {
                id: id.to_string(),
                session_id: "left".to_string(),
                direction: "clientToServer".to_string(),
                timestamp: format!("2026-10-17T10:00:0{}Z", if id == "wm-1" { 0 } else { 1 }),
                opcode: "text".to_string(),
                payload_text: Some(text.to_string()),
                payload_size: text.len(),
                fin: true,
                truncated: false,
            },
        )
        .unwrap();
    }

    connection
        .execute_batch(
            r#"
            INSERT INTO workspaces (id, name, created_at, updated_at)
            VALUES ('ws-agent', 'Agent', '2026-10-17T10:00:00Z', '2026-10-17T10:00:00Z');
            INSERT INTO rewrite_rules (id, workspace_id, name, rewrite_type)
            VALUES ('rewrite-rule-1', 'ws-agent', 'Rewrite secret', 'header');
            INSERT INTO map_rules (id, workspace_id, mode, name, source_pattern, target_value)
            VALUES ('map-rule-1', 'ws-agent', 'remote', 'Map secret', '*', 'https://target.example.com');
            INSERT INTO script_rules
                (id, workspace_id, name, language, source_type, source_code, compiled_code, updated_at)
            VALUES ('script-rule-1', 'ws-agent', 'Script secret', 'javascript', 'inline', '', '', '2026-10-17T10:00:00Z');
            INSERT INTO rewrite_runs
                (id, session_id, rule_id, rule_name, workspace_id, rewrite_type, stage, outcome, duration_ms, created_at)
            VALUES ('rewrite-run-1', 'left', 'rewrite-rule-1', 'Rewrite secret', 'ws-agent', 'header', 'request', 'applied', 3, '2026-10-17T10:00:00Z');
            INSERT INTO rewrite_run_entries
                (id, run_id, kind, key, before_value, after_value, message, seq)
            VALUES
                ('rewrite-entry-1', 'rewrite-run-1', 'header', 'Authorization', 'Bearer rewrite-trace-secret', 'Bearer rewrite-after-secret', 'token=rewrite-message-secret', 0);
            INSERT INTO script_runs
                (id, session_id, rule_id, workspace_id, stage, outcome, duration_ms, created_at)
            VALUES ('script-run-1', 'left', 'script-rule-1', 'ws-agent', 'request', 'applied', 4, '2026-10-17T10:00:00Z');
            INSERT INTO script_run_entries (id, run_id, kind, level, key, message, payload_json, seq)
            VALUES ('script-entry-1', 'script-run-1', 'log', 'info', 'Authorization', 'Authorization: Bearer script-trace-secret', NULL, 0);
            INSERT INTO map_runs
                (id, session_id, workspace_id, rule_id, rule_name, mode, outcome, source_pattern,
                 target_value, original_url, mapped_url, local_path, duration_ms, sequence, created_at)
            VALUES
                ('map-run-1', 'left', 'ws-agent', 'map-rule-1', 'Map secret', 'remote', 'applied',
                 'https://api.example.com/v1?token=source-trace-secret', 'https://target.example.com',
                 'https://api.example.com/v1', 'https://mapped.example.com/v1?access_token=mapped-trace-secret',
                 NULL, 5, 0, '2026-10-17T10:00:00Z');
            "#,
        )
        .unwrap();
    drop(connection);

    let paths = AppPaths::resolve(Some(directory.clone()), None).unwrap();
    write_config(
        &paths.config_path,
        &AgentAccessConfig {
            enabled: true,
            permissions: AgentAccessPermissions {
                read_sessions: true,
                read_bodies: true,
                read_raw_bodies: false,
                read_web_socket: true,
                export_snapshots: false,
                ..AgentAccessPermissions::default()
            },
            ..AgentAccessConfig::default()
        },
    )
    .unwrap();

    let context = AppContext::new(paths);
    (directory, context)
}

fn insert_inline_body_session(directory: &Path, id: &str, body: &str, mime_type: &str) {
    let connection = aiproxy_db::rusqlite::Connection::open(directory.join("aiproxy.db")).unwrap();
    let summary = SessionSummaryRow {
        id: id.to_string(),
        method: "GET".to_string(),
        host: "api.example.com".to_string(),
        path: format!("/{id}"),
        protocol: "HTTP/2".to_string(),
        scheme: "https".to_string(),
        http_version: "2".to_string(),
        transport_protocol: "tcp".to_string(),
        application_protocol: "http".to_string(),
        started_at: "2026-10-17T11:00:00Z".to_string(),
        finished_at: "2026-10-17T11:00:01Z".to_string(),
        duration_ms: 50,
        size_bytes: body.len(),
        status_code: 200,
        url: format!("https://api.example.com/{id}"),
        response_mime_type: Some(mime_type.to_string()),
    };
    let detail = SessionDetailRow {
        id: format!("{id}-detail"),
        session_summary_id: id.to_string(),
        query_params: "[]".to_string(),
        cookies: "[]".to_string(),
        request_headers: "[]".to_string(),
        response_headers: "[]".to_string(),
        raw_request: None,
        raw_response: None,
        client_address: None,
        server_ip: None,
        tls_cipher_suite: None,
        tls_protocol: None,
        request_body_ref: None,
        response_body_ref: Some(
            json!({
                "file_path": null,
                "inline_text": body,
                "base64_text": null,
                "mime_type": mime_type,
                "encoding": null,
                "size_bytes": body.len(),
                "truncated": false,
            })
            .to_string(),
        ),
        timing: None,
        trailers: None,
        h2_stream_id: None,
        via_upstream_proxy: None,
    };
    upsert_session(&connection, &summary, &detail).unwrap();
}

#[tokio::test]
async fn search_get_body_and_compare_are_redacted_by_default() {
    let (directory, context) = create_fixture("redaction");

    let (search_data, search_meta) = search(
        &context,
        SearchSessionsRequest {
            host: Some("api.example.com".to_string()),
            limit: Some(1),
            compact: true,
            ..SearchSessionsRequest::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(search_data["items"].as_array().unwrap().len(), 1);
    assert!(search_data["items"][0].get("url").is_none());
    assert_eq!(search_data["items"][0]["host"], "api.example.com");
    assert!(search_meta.next_cursor.is_some());

    let (filtered, _) = search(
        &context,
        SearchSessionsRequest {
            host: Some("api.example.com".to_string()),
            path_contains: Some("chat".to_string()),
            query_params: [("token".to_string(), "secret-query".to_string())]
                .into_iter()
                .collect(),
            sort_by: aiproxy_mcp::tools::sessions::SessionSortBy::DurationMs,
            limit: Some(20),
            ..SearchSessionsRequest::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(filtered["items"].as_array().unwrap().len(), 2);
    assert_eq!(filtered["items"][0]["sessionId"], "right");

    let (session_data, _) = get_session(
        &context,
        GetSessionRequest {
            session_id: "left".to_string(),
            include: vec![
                SessionInclude::Headers,
                SessionInclude::Cookies,
                SessionInclude::Timing,
                SessionInclude::RuleTraces,
            ],
            redaction_mode: RedactionMode::RedactedText,
        },
    )
    .await
    .unwrap();
    let serialized = session_data.to_string();
    assert!(serialized.contains("[REDACTED]"));
    assert!(!serialized.contains("secret-token"));
    assert!(!serialized.contains("cookie-secret"));
    assert!(!serialized.contains("rewrite-trace-secret"));
    assert!(!serialized.contains("rewrite-after-secret"));
    assert!(!serialized.contains("rewrite-message-secret"));
    assert!(!serialized.contains("script-trace-secret"));
    assert!(!serialized.contains("source-trace-secret"));
    assert!(!serialized.contains("mapped-trace-secret"));
    assert!(session_data["redactedFields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field == "authorization"));

    let (body_data, body_meta) = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "left".to_string(),
            part: BodyPart::Response,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: Some(64),
            json_paths: Vec::new(),
            text_query: None,
            context_bytes: None,
            include_form_params: false,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap();
    let body_text = body_data["text"].as_str().unwrap();
    assert!(!body_text.contains("secret-left"), "{body_text}");
    assert!(body_meta.redacted);

    let raw_error = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "left".to_string(),
            part: BodyPart::Response,
            redaction_mode: BodyRedactionMode::Raw,
            offset: None,
            max_bytes: None,
            json_paths: Vec::new(),
            text_query: None,
            context_bytes: None,
            include_form_params: false,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(raw_error.code, "PERMISSION_DENIED");

    let (field_body, _) = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "left".to_string(),
            part: BodyPart::Response,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: vec!["$.ab.ab_test".to_string()],
            text_query: None,
            context_bytes: None,
            include_form_params: false,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap();
    assert_eq!(field_body["jsonPaths"][0]["value"], "A");
    assert_eq!(field_body["jsonPaths"][0]["found"], true);
    assert!(field_body["decodedSizeBytes"].as_u64().unwrap() > 0);
    assert!(
        field_body["decodedSizeBytes"].as_u64().unwrap()
            > field_body["wireSizeBytes"].as_u64().unwrap()
    );
    assert!(field_body["returnedBytes"].as_u64().unwrap() < 500);
    assert!(field_body.get("text").is_some_and(Value::is_null));

    let (searched_body, _) = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "left".to_string(),
            part: BodyPart::Response,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: Vec::new(),
            text_query: Some("hello".to_string()),
            context_bytes: Some(20),
            include_form_params: false,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap();
    assert_eq!(searched_body["textMatches"][0]["match"], "hello");

    let (fields, _) = get_session_fields(
        &context,
        GetSessionFieldsRequest {
            session_ids: vec!["left".to_string(), "right".to_string()],
            part: BodyPart::Response,
            json_paths: vec!["$.ab.ab_test".to_string()],
            redaction_mode: BodyRedactionMode::RedactedText,
        },
    )
    .await
    .unwrap();
    assert_eq!(fields["items"][0]["values"][0]["value"], "A");
    assert_eq!(fields["items"][1]["values"][0]["value"], "B");

    let (compare_data, compare_meta) = compare_sessions(
        &context,
        CompareSessionsRequest {
            left_session_id: "left".to_string(),
            right_session_id: "right".to_string(),
            include_body: true,
            body_part: Some(BodyPart::Response),
            redaction_mode: RedactionMode::RedactedText,
            json_paths: vec!["$.ab.ab_test".to_string()],
            diff_mode: DiffMode::Auto,
        },
    )
    .await
    .unwrap();
    assert_eq!(compare_data["summaryDiff"]["statusCode"]["changed"], true);
    assert_eq!(compare_data["bodyDiff"]["structureParsed"], true);
    assert_eq!(compare_data["bodyDiff"]["differences"]["scope"], "paths");
    assert_eq!(
        compare_data["bodyDiff"]["differences"]["changes"][0]["right"],
        "B"
    );
    assert!(compare_meta.redacted);
    assert!(!compare_data.to_string().contains("secret-left"));

    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn websocket_and_insights_use_permissions_and_scope() {
    let (directory, context) = create_fixture("ws_insights");

    let (ws_data, ws_meta) = get_messages(
        &context,
        GetWebSocketMessagesRequest {
            session_id: "left".to_string(),
            direction: None,
            keyword: None,
            limit: Some(1),
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(ws_data["items"].as_array().unwrap().len(), 1);
    assert!(ws_meta.next_cursor.is_some());

    let (insights, _) = get_insights(
        &context,
        GetInsightsRequest {
            host: Some("api.example.com".to_string()),
            group_by: GroupBy::Path,
            ..GetInsightsRequest::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(insights["totalRequests"], 2);
    assert_eq!(insights["totalErrors"], 1);
    assert_eq!(insights["groups"][0]["key"], "/v1/chat");
    assert_eq!(insights["groups"][0]["requestCount"], 2);
    let serialized = insights.to_string();
    assert!(!serialized.contains("secret"));

    let error = get_insights(
        &context,
        GetInsightsRequest {
            ..GetInsightsRequest::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");

    let (by_since, _) = get_insights(
        &context,
        GetInsightsRequest {
            since: Some("30d".to_string()),
            ..GetInsightsRequest::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(by_since["totalRequests"], 2);

    let conflict = get_insights(
        &context,
        GetInsightsRequest {
            since: Some("30d".to_string()),
            started_after: Some("2026-10-17T00:00:00Z".to_string()),
            ..GetInsightsRequest::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(conflict.code, "INVALID_ARGUMENT");

    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn session_prefixes_and_since_are_resolved_safely() {
    let (directory, context) = create_fixture("prefix");
    insert_inline_body_session(
        &directory,
        "prefix-session-alpha",
        r#"{"ok":true}"#,
        "application/json",
    );
    insert_inline_body_session(
        &directory,
        "prefix-session-beta",
        r#"{"ok":false}"#,
        "application/json",
    );
    insert_inline_body_session(
        &directory,
        "unique-session-omega",
        r#"{"ok":true}"#,
        "application/json",
    );

    let (session, _) = get_session(
        &context,
        GetSessionRequest {
            session_id: "unique-session".to_string(),
            include: vec![SessionInclude::Summary],
            redaction_mode: RedactionMode::RedactedText,
        },
    )
    .await
    .unwrap();
    assert_eq!(session["summary"]["sessionId"], "unique-session-omega");

    let ambiguous = get_session(
        &context,
        GetSessionRequest {
            session_id: "prefix-session".to_string(),
            include: vec![SessionInclude::Summary],
            redaction_mode: RedactionMode::RedactedText,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(ambiguous.code, "SESSION_ID_AMBIGUOUS");
    assert_eq!(
        ambiguous.details.as_ref().unwrap()["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let (recent, _) = search(
        &context,
        SearchSessionsRequest {
            host: Some("api.example.com".to_string()),
            since: Some("30d".to_string()),
            compact: true,
            limit: Some(20),
            ..SearchSessionsRequest::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(recent["items"].as_array().unwrap().len(), 5);

    let _ = std::fs::remove_dir_all(directory);
}

fn insert_form_request_session(directory: &Path, id: &str, body: &str, mime_type: &str) {
    let connection = aiproxy_db::rusqlite::Connection::open(directory.join("aiproxy.db")).unwrap();
    let summary = SessionSummaryRow {
        id: id.to_string(),
        method: "POST".to_string(),
        host: "api.example.com".to_string(),
        path: format!("/{id}"),
        protocol: "HTTP/2".to_string(),
        scheme: "https".to_string(),
        http_version: "2".to_string(),
        transport_protocol: "tcp".to_string(),
        application_protocol: "http".to_string(),
        started_at: "2026-10-17T12:00:00Z".to_string(),
        finished_at: "2026-10-17T12:00:01Z".to_string(),
        duration_ms: 60,
        size_bytes: body.len(),
        status_code: 200,
        url: format!("https://api.example.com/{id}"),
        response_mime_type: None,
    };
    let detail = SessionDetailRow {
        id: format!("{id}-detail"),
        session_summary_id: id.to_string(),
        query_params: "[]".to_string(),
        cookies: "[]".to_string(),
        request_headers: json!([{ "name": "Content-Type", "value": mime_type }]).to_string(),
        response_headers: "[]".to_string(),
        raw_request: None,
        raw_response: None,
        client_address: None,
        server_ip: None,
        tls_cipher_suite: None,
        tls_protocol: None,
        request_body_ref: Some(
            json!({
                "file_path": null,
                "inline_text": body,
                "base64_text": null,
                "mime_type": mime_type,
                "encoding": null,
                "size_bytes": body.len(),
                "truncated": false,
            })
            .to_string(),
        ),
        response_body_ref: None,
        timing: None,
        trailers: None,
        h2_stream_id: None,
        via_upstream_proxy: None,
    };
    upsert_session(&connection, &summary, &detail).unwrap();
}

#[tokio::test]
async fn form_request_parameters_are_extracted_and_redacted() {
    let (directory, context) = create_fixture("form_params");
    insert_form_request_session(
        &directory,
        "form-urlencoded",
        "user_id=42&password=hunter2&page=2&tag=a&tag=b&note=hello+world&encoded=%E4%B8%AD%E6%96%87&email=alice%40example.com",
        "application/x-www-form-urlencoded; charset=UTF-8",
    );
    let multipart = concat!(
        "--AABoundary\r\n",
        "Content-Disposition: form-data; name=\"title\"\r\n\r\n",
        "hello form\r\n",
        "--AABoundary\r\n",
        "Content-Disposition: form-data; name=\"avatar\"; filename=\"a.png\"\r\n",
        "Content-Type: image/png\r\n\r\n",
        "fake-png-bytes\r\n",
        "--AABoundary--\r\n"
    );
    insert_form_request_session(
        &directory,
        "form-multipart",
        multipart,
        "multipart/form-data; boundary=AABoundary",
    );

    let (all, meta) = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "form-urlencoded".to_string(),
            part: BodyPart::Request,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: Vec::new(),
            text_query: None,
            context_bytes: None,
            include_form_params: true,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap();
    assert_eq!(all["encoding"], "form");
    assert_eq!(all["formFormat"], "urlencoded");
    assert_eq!(all["formParamCount"], 8);
    assert_eq!(all["formParamsTruncated"], false);
    assert_eq!(all["formParams"][0]["name"], "user_id");
    assert_eq!(all["formParams"][0]["found"], true);
    // Identifier names are replaced with a stable pseudonym, never the raw id.
    assert!(all["formParams"][0]["value"]
        .as_str()
        .unwrap()
        .starts_with("[ID:"));
    assert_eq!(all["formParams"][1]["value"], "[REDACTED]");
    assert_eq!(all["formParams"][2]["value"], "2");
    assert_eq!(all["formParams"][4]["value"], "b");
    assert_eq!(all["formParams"][5]["value"], "hello world");
    assert_eq!(all["formParams"][6]["value"], "中文");
    assert!(all["formParams"][7]["value"]
        .as_str()
        .unwrap()
        .starts_with("[EMAIL:"));
    let serialized = all.to_string();
    assert!(!serialized.contains("hunter2"));
    assert!(!serialized.contains("alice@example.com"));
    assert!(meta.redacted);

    let (selected, _) = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "form-urlencoded".to_string(),
            part: BodyPart::Request,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: Vec::new(),
            text_query: None,
            context_bytes: None,
            include_form_params: false,
            form_param_names: vec!["page".to_string(), "missing".to_string()],
        },
    )
    .await
    .unwrap();
    assert_eq!(selected["formParamCount"], 8);
    assert_eq!(selected["formParams"][0]["name"], "page");
    assert_eq!(selected["formParams"][0]["found"], true);
    assert_eq!(selected["formParams"][0]["value"], "2");
    assert_eq!(selected["formParams"][1]["name"], "missing");
    assert_eq!(selected["formParams"][1]["found"], false);
    assert_eq!(selected["formParams"][1]["valueType"], "missing");

    let (multipart_body, _) = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "form-multipart".to_string(),
            part: BodyPart::Request,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: Vec::new(),
            text_query: None,
            context_bytes: None,
            include_form_params: true,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap();
    assert_eq!(multipart_body["formFormat"], "multipart");
    assert_eq!(multipart_body["formParamCount"], 2);
    assert_eq!(multipart_body["formParams"][0]["name"], "title");
    assert_eq!(multipart_body["formParams"][0]["value"], "hello form");
    assert_eq!(multipart_body["formParams"][1]["name"], "avatar");
    assert_eq!(multipart_body["formParams"][1]["valueType"], "file");
    assert!(multipart_body["formParams"][1]["value"].is_null());
    assert_eq!(multipart_body["formParams"][1]["fileName"], "a.png");
    assert_eq!(multipart_body["formParams"][1]["contentType"], "image/png");
    assert_eq!(multipart_body["formParams"][1]["sizeBytes"], 14);

    let not_form = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "left".to_string(),
            part: BodyPart::Response,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: Vec::new(),
            text_query: None,
            context_bytes: None,
            include_form_params: true,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(not_form.code, "BODY_NOT_FORM");

    let conflict = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "form-urlencoded".to_string(),
            part: BodyPart::Request,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: Vec::new(),
            text_query: None,
            context_bytes: None,
            include_form_params: true,
            form_param_names: vec!["page".to_string()],
        },
    )
    .await
    .unwrap_err();
    assert_eq!(conflict.code, "INVALID_ARGUMENT");

    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn body_extraction_reports_non_json_and_invalid_paths() {
    let (directory, context) = create_fixture("body_errors");
    insert_inline_body_session(&directory, "plain-text-session", "not-json", "text/plain");
    insert_inline_body_session(
        &directory,
        "plain-text-session-2",
        "also-not-json",
        "text/plain",
    );

    let not_json = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "plain-text-session".to_string(),
            part: BodyPart::Response,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: vec!["$.ab.ab_test".to_string()],
            text_query: None,
            context_bytes: None,
            include_form_params: false,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(not_json.code, "BODY_NOT_JSON");

    let invalid_path = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "left".to_string(),
            part: BodyPart::Response,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: vec!["ab.ab_test".to_string()],
            text_query: None,
            context_bytes: None,
            include_form_params: false,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(invalid_path.code, "JSON_PATH_INVALID");

    let (fields, _) = get_session_fields(
        &context,
        GetSessionFieldsRequest {
            session_ids: vec![
                "left".to_string(),
                "plain-text-session".to_string(),
                "missing-session".to_string(),
            ],
            part: BodyPart::Response,
            json_paths: vec!["$.ab.ab_test".to_string()],
            redaction_mode: BodyRedactionMode::RedactedText,
        },
    )
    .await
    .unwrap();
    assert_eq!(fields["items"][0]["values"][0]["value"], "A");
    assert_eq!(fields["items"][1]["error"]["code"], "BODY_NOT_JSON");
    assert_eq!(fields["items"][2]["error"]["code"], "SESSION_NOT_FOUND");

    let compare_error = compare_sessions(
        &context,
        CompareSessionsRequest {
            left_session_id: "plain-text-session".to_string(),
            right_session_id: "plain-text-session-2".to_string(),
            include_body: true,
            body_part: Some(BodyPart::Response),
            redaction_mode: RedactionMode::RedactedText,
            json_paths: Vec::new(),
            diff_mode: DiffMode::Json,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(compare_error.code, "BODY_NOT_JSON");

    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn custom_sensitive_keys_and_disabled_hashing_apply_from_config() {
    let (directory, _context) = create_fixture("custom_redaction");
    insert_inline_body_session(
        &directory,
        "custom-redaction",
        r#"{"employee_id":"EMP-123","email":"alice@example.com","device_id":"device-123","message":"ok"}"#,
        "application/json",
    );
    let paths = AppPaths::resolve(Some(directory.clone()), None).unwrap();
    write_config(
        &paths.config_path,
        &AgentAccessConfig {
            enabled: true,
            permissions: AgentAccessPermissions {
                read_sessions: true,
                read_bodies: true,
                read_raw_bodies: false,
                read_web_socket: false,
                export_snapshots: false,
                ..AgentAccessPermissions::default()
            },
            redaction: AgentAccessRedaction {
                detect_sensitive_values: true,
                hash_identifiers: false,
                custom_sensitive_keys: vec!["employee_id".to_string()],
                custom_patterns: Vec::new(),
            },
            ..AgentAccessConfig::default()
        },
    )
    .unwrap();
    let context = AppContext::new(paths);

    let (body, meta) = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "custom-redaction".to_string(),
            part: BodyPart::Response,
            redaction_mode: BodyRedactionMode::RedactedText,
            offset: None,
            max_bytes: None,
            json_paths: vec![
                "$.employee_id".to_string(),
                "$.email".to_string(),
                "$.device_id".to_string(),
                "$.message".to_string(),
            ],
            text_query: None,
            context_bytes: None,
            include_form_params: false,
            form_param_names: Vec::new(),
        },
    )
    .await
    .unwrap();

    assert_eq!(body["jsonPaths"][0]["value"], "[REDACTED]");
    assert_eq!(body["jsonPaths"][1]["value"], "[REDACTED]");
    assert_eq!(body["jsonPaths"][2]["value"], "[REDACTED]");
    assert_eq!(body["jsonPaths"][3]["value"], "ok");
    assert!(meta.redacted);

    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn raw_session_and_compare_require_and_honor_raw_permission() {
    let (directory, _context) = create_fixture("raw");
    let paths = AppPaths::resolve(Some(directory.clone()), None).unwrap();
    write_config(
        &paths.config_path,
        &AgentAccessConfig {
            enabled: true,
            permissions: AgentAccessPermissions {
                read_sessions: true,
                read_bodies: true,
                read_raw_bodies: true,
                read_web_socket: false,
                export_snapshots: false,
                ..AgentAccessPermissions::default()
            },
            ..AgentAccessConfig::default()
        },
    )
    .unwrap();
    let context = AppContext::new(paths);

    let (session, meta) = get_session(
        &context,
        GetSessionRequest {
            session_id: "left".to_string(),
            include: vec![
                SessionInclude::Summary,
                SessionInclude::Headers,
                SessionInclude::RuleTraces,
            ],
            redaction_mode: RedactionMode::Raw,
        },
    )
    .await
    .unwrap();
    assert!(!meta.redacted);
    assert_eq!(
        session["summary"]["url"],
        "https://api.example.com/v1/chat?token=secret"
    );
    assert!(session.to_string().contains("Bearer secret-token"));
    assert!(session.to_string().contains("rewrite-trace-secret"));

    let (compare, meta) = compare_sessions(
        &context,
        CompareSessionsRequest {
            left_session_id: "left".to_string(),
            right_session_id: "right".to_string(),
            include_body: true,
            body_part: Some(BodyPart::Response),
            redaction_mode: RedactionMode::Raw,
            json_paths: Vec::new(),
            diff_mode: DiffMode::Auto,
        },
    )
    .await
    .unwrap();
    assert!(!meta.redacted);
    let serialized = compare.to_string();
    assert!(serialized.contains("secret-left"));
    assert!(serialized.contains("secret-right"));

    let (fields, fields_meta) = get_session_fields(
        &context,
        GetSessionFieldsRequest {
            session_ids: vec!["left".to_string()],
            part: BodyPart::Response,
            json_paths: vec!["$.token".to_string()],
            redaction_mode: BodyRedactionMode::Raw,
        },
    )
    .await
    .unwrap();
    assert_eq!(fields["items"][0]["values"][0]["value"], "secret-left");
    assert!(!fields_meta.redacted);

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn fixture_shape_is_serializable() {
    let (directory, context) = create_fixture("shape");
    let _: Value = context.doctor_result();
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn sidecar_doctor_reports_ready_fixture() {
    let (directory, _context) = create_fixture("doctor");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_aiproxy-mcp"))
        .args([
            "--data-dir",
            directory.to_str().unwrap(),
            "--doctor",
            "--log-level",
            "error",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "doctor failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let parsed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["data"]["schemaCompatible"], true);
    assert_eq!(parsed["data"]["configReadable"], true);
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn tool_meta_reports_freshness_and_capture_status() {
    let (directory, context) = create_fixture("freshness");
    let status_path = directory.join("agent-status.json");
    std::fs::write(
        &status_path,
        json!({
            "appRunning": true,
            "capturing": true,
            "proxyPort": 8888,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        })
        .to_string(),
    )
    .unwrap();

    let freshness = context.freshness();
    assert_eq!(
        freshness.latest_session_at.as_deref(),
        Some("2026-10-17T10:00:01Z")
    );
    assert_eq!(freshness.capture_status, "running");
    assert!(freshness.capture_updated_at.is_some());

    std::fs::write(
        &status_path,
        json!({
            "appRunning": true,
            "capturing": true,
            "proxyPort": 8888,
            "updatedAt": (chrono::Utc::now() - chrono::Duration::seconds(600)).to_rfc3339(),
        })
        .to_string(),
    )
    .unwrap();
    let stale_freshness = context.freshness();
    assert_eq!(stale_freshness.capture_status, "unknown");

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn doctor_reports_disabled_agent_access() {
    let (directory, context) = create_fixture("doctor_disabled");
    write_config(
        &context.paths.config_path,
        &AgentAccessConfig {
            enabled: false,
            ..AgentAccessConfig::default()
        },
    )
    .unwrap();

    let result = context.doctor_result();
    assert_eq!(result["ok"], false);
    assert_eq!(result["data"]["agentAccessEnabled"], false);
    assert!(result["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|issue| issue["code"] == "AGENT_ACCESS_DISABLED"));

    write_config(
        &context.paths.config_path,
        &AgentAccessConfig {
            enabled: true,
            ..AgentAccessConfig::default()
        },
    )
    .unwrap();
    let result = context.doctor_result();
    assert_eq!(result["ok"], true);
    assert_eq!(result["data"]["agentAccessEnabled"], true);
    assert_eq!(result["data"]["schemaCompatible"], true);
    assert_eq!(result["data"]["capabilities"]["sessionDetails"], true);

    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn stale_schema_returns_actionable_migration_error() {
    let (directory, _context) = create_fixture("stale_schema");
    {
        let connection =
            aiproxy_db::rusqlite::Connection::open(directory.join("aiproxy.db")).unwrap();
        connection
            .execute(
                "ALTER TABLE session_details DROP COLUMN via_upstream_proxy",
                [],
            )
            .unwrap();
    }

    let context = AppContext::new(AppPaths::resolve(Some(directory.clone()), None).unwrap());
    let doctor = context.doctor_result();
    assert_eq!(doctor["ok"], false);
    assert_eq!(doctor["data"]["schemaCompatible"], false);
    assert!(doctor["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|issue| issue["code"] == "SCHEMA_INCOMPATIBLE"));

    let error = get_session(
        &context,
        GetSessionRequest {
            session_id: "left".to_string(),
            include: vec![SessionInclude::Headers],
            redaction_mode: RedactionMode::RedactedText,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "SCHEMA_INCOMPATIBLE");
    assert!(error.message.contains("Open AIProxy"));

    let (search_data, _) = search(
        &context,
        SearchSessionsRequest {
            limit: Some(1),
            ..SearchSessionsRequest::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(search_data["items"].as_array().unwrap().len(), 1);

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn sidecar_handles_mcp_initialize_and_tools_list() {
    let (directory, context) = create_fixture("stdio");
    std::fs::write(
        directory.join("agent-status.json"),
        json!({
            "appRunning": true,
            "capturing": true,
            "proxyPort": 8888,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        })
        .to_string(),
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_aiproxy-mcp"))
        .args([
            "--data-dir",
            directory.to_str().unwrap(),
            "--log-level",
            "error",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    writeln!(
        stdin,
        "{}",
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "aiproxy-test", "version": "1.0" }
            }
        })
    )
    .unwrap();
    let initialize: Value = serde_json::from_str(
        &receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("initialize response timed out"),
    )
    .unwrap();
    assert_eq!(initialize["id"], 1);
    assert!(initialize["result"]["serverInfo"]["name"]
        .as_str()
        .is_some());

    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} })
    )
    .unwrap();

    let mut tools = Vec::new();
    for _ in 0..4 {
        let line = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("tools/list response timed out");
        let value: Value = serde_json::from_str(&line).unwrap();
        if value["id"] == 2 {
            tools = value["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|tool| tool["name"].as_str().map(str::to_string))
                .collect();
            break;
        }
    }
    assert!(tools.contains(&"search_sessions".to_string()));
    assert!(tools.contains(&"get_session_body".to_string()));
    assert!(tools.contains(&"get_session_fields".to_string()));
    assert!(tools.contains(&"get_app_status".to_string()));
    assert!(tools.contains(&"configure_workspace".to_string()));
    assert!(tools.contains(&"clear_sessions".to_string()));
    assert_eq!(tools.len(), 18);

    writeln!(
        stdin,
        "{}",
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": "search_sessions", "arguments": { "limit": 1 } }
        })
    )
    .unwrap();
    let mut envelope = Value::Null;
    for _ in 0..4 {
        let line = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("tools/call response timed out");
        let value: Value = serde_json::from_str(&line).unwrap();
        if value["id"] == 3 {
            envelope = serde_json::from_str(
                value["result"]["content"][0]["text"]
                    .as_str()
                    .expect("tool response text"),
            )
            .unwrap();
            break;
        }
    }
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["meta"]["schemaVersion"], MCP_TOOL_SCHEMA_VERSION);
    assert_eq!(envelope["meta"]["latestSessionAt"], "2026-10-17T10:00:01Z");
    assert_eq!(envelope["meta"]["captureStatus"], "running");
    assert!(envelope["meta"]["captureUpdatedAt"].is_string());

    write_config(
        &context.paths.config_path,
        &AgentAccessConfig {
            enabled: true,
            permissions: AgentAccessPermissions {
                read_sessions: true,
                read_bodies: true,
                read_raw_bodies: false,
                read_web_socket: true,
                export_snapshots: false,
                ..AgentAccessPermissions::default()
            },
            limits: AgentAccessLimits {
                max_response_bytes: 1,
                ..AgentAccessLimits::default()
            },
            ..AgentAccessConfig::default()
        },
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": { "name": "search_sessions", "arguments": { "limit": 1 } }
        })
    )
    .unwrap();
    let mut limit_error = Value::Null;
    for _ in 0..4 {
        let line = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("limited tools/call response timed out");
        let value: Value = serde_json::from_str(&line).unwrap();
        if value["id"] == 4 {
            limit_error = serde_json::from_str(
                value["result"]["content"][0]["text"]
                    .as_str()
                    .expect("limited tool response text"),
            )
            .unwrap();
            break;
        }
    }
    assert_eq!(limit_error["ok"], false);
    assert_eq!(limit_error["error"]["code"], "RESULT_TOO_LARGE");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(directory);
}
