use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;

use aiproxy_db::sessions::{
    insert_ws_message, upsert_session, SessionDetailRow, SessionSummaryRow, WsMessageRow,
};
use aiproxy_mcp::config::{write_config, AgentAccessConfig, AgentAccessPermissions, AppPaths};
use aiproxy_mcp::tools::body::{
    get_session_body, BodyPart, BodyRedactionMode, GetSessionBodyRequest,
};
use aiproxy_mcp::tools::compare::{compare_sessions, CompareSessionsRequest};
use aiproxy_mcp::tools::insights::{get_insights, GetInsightsRequest};
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
        let body = format!("{{\"token\":\"secret-{id}\",\"message\":\"{message}\"}}");
        let body_ref = json!({
            "file_path": null,
            "inline_text": body,
            "base64_text": null,
            "mime_type": "application/json",
            "encoding": null,
            "size_bytes": body.len(),
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
            },
            ..AgentAccessConfig::default()
        },
    )
    .unwrap();

    let context = AppContext::new(paths);
    (directory, context)
}

#[tokio::test]
async fn search_get_body_and_compare_are_redacted_by_default() {
    let (directory, context) = create_fixture("redaction");

    let (search_data, search_meta) = search(
        &context,
        SearchSessionsRequest {
            host: Some("api.example.com".to_string()),
            host_contains: None,
            method: None,
            status_min: None,
            status_max: None,
            protocol: None,
            mime: None,
            started_after: None,
            started_before: None,
            min_duration_ms: None,
            max_duration_ms: None,
            keyword: None,
            search_in: Vec::new(),
            limit: Some(1),
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(search_data["items"].as_array().unwrap().len(), 1);
    assert!(search_meta.next_cursor.is_some());

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
        },
    )
    .await
    .unwrap();
    let body_text = body_data["text"].as_str().unwrap();
    assert!(body_text.contains("[REDACTED]"));
    assert!(!body_text.contains("secret-left"));
    assert!(body_meta.redacted);

    let raw_error = get_session_body(
        &context,
        GetSessionBodyRequest {
            session_id: "left".to_string(),
            part: BodyPart::Response,
            redaction_mode: BodyRedactionMode::Raw,
            offset: None,
            max_bytes: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(raw_error.code, "PERMISSION_DENIED");

    let (compare_data, compare_meta) = compare_sessions(
        &context,
        CompareSessionsRequest {
            left_session_id: "left".to_string(),
            right_session_id: "right".to_string(),
            include_body: true,
            body_part: Some(BodyPart::Response),
            redaction_mode: RedactionMode::RedactedText,
        },
    )
    .await
    .unwrap();
    assert_eq!(compare_data["summaryDiff"]["statusCode"]["changed"], true);
    assert_eq!(compare_data["bodyDiff"]["structureParsed"], true);
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
            host_contains: None,
            methods: Vec::new(),
            status_min: None,
            status_max: None,
            started_after: None,
            started_before: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(insights["totalRequests"], 2);
    assert_eq!(insights["totalErrors"], 1);
    let serialized = insights.to_string();
    assert!(!serialized.contains("secret"));

    let error = get_insights(
        &context,
        GetInsightsRequest {
            host: None,
            host_contains: None,
            methods: Vec::new(),
            status_min: None,
            status_max: None,
            started_after: None,
            started_before: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");

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
        },
    )
    .await
    .unwrap();
    assert!(!meta.redacted);
    let serialized = compare.to_string();
    assert!(serialized.contains("secret-left"));
    assert!(serialized.contains("secret-right"));

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

#[test]
fn sidecar_handles_mcp_initialize_and_tools_list() {
    let (directory, _context) = create_fixture("stdio");
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
    assert_eq!(tools.len(), 7);

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(directory);
}
