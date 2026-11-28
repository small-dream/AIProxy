use std::sync::Arc;

use aiproxy_agent_control::WaitForSessionJsonRewriteParams;

use aiproxy_db::workspaces;
use aiproxy_proxy_core::{start_proxy_server, ProxyConfig, ProxyManagers, ProxyRuntimeConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

use super::super::tests::{automation_permissions, session_fixture, test_harness, WORKSPACE_ID};
use super::*;

const CLIENT: (&str, &str) = ("test-agent", "1.0");
const PATH: &str = "$.mydeals_bc_v3.mydeals_theme_info.hide_user_name";
const SOURCE: &str = "source-session";
const EXAMPLE_URL: &str =
    "https://api.example.test/api/?_method=site.get_mydeals_drawer&_timestamp=gone";
const BODY: &str =
    r#"{ "mydeals_bc_v3": {"mydeals_theme_info": {"hide_user_name":0}}, "amount":12.00 }"#;

fn params(mode: SessionJsonRewriteMode) -> CreateSessionJsonRewriteParams {
    CreateSessionJsonRewriteParams {
        mode,
        session_id: SOURCE.to_owned(),
        json_path: PATH.to_owned(),
        value: json!(1),
        match_query_keys: None,
        ttl_seconds: 600,
        idempotency_key: Some("session-rewrite-test-0001".to_owned()),
    }
}

async fn capture(state: &AppState, id: &str, url: &str, version: &str, time: &str, source: &str) {
    let mut detail = session_fixture(id, time, Some(source));
    let parsed = Url::parse(url).unwrap();
    detail.summary.url = url.to_owned();
    detail.summary.scheme = parsed.scheme().to_owned();
    detail.summary.host = parsed.host_str().unwrap().to_owned();
    detail.summary.path = parsed.path().to_owned();
    detail.summary.method = "POST".to_owned();
    detail.summary.http_version = version.to_owned();
    state.upsert_session_async(detail).await;
}

#[tokio::test]
async fn current_http2_blocks_publication_and_reports_saved_runtime_drift() {
    let harness = test_harness();
    let state = &harness.state;
    {
        let conn = state.lock_db_for_ipc().unwrap();
        let mut row = workspaces::load_all_workspaces(&conn)
            .unwrap()
            .into_iter()
            .find(|workspace| workspace.id == WORKSPACE_ID)
            .unwrap();
        row.http2_enabled = false;
        workspaces::upsert_workspace(&conn, &row).unwrap();
        state.read_workspace_manager().set_workspaces(
            workspaces::load_all_workspaces(&conn)
                .unwrap()
                .into_iter()
                .map(crate::bootstrap::converters::workspace_row_to_data)
                .collect(),
        );
    }
    state.start_proxy(8888, true, true, WORKSPACE_ID.to_owned());
    capture(
        state,
        SOURCE,
        EXAMPLE_URL,
        "2",
        &Utc::now().to_rfc3339(),
        "proxy",
    )
    .await;

    let result = state
        .create_session_json_rewrite(
            params(SessionJsonRewriteMode::Create),
            CLIENT,
            automation_permissions(),
        )
        .await
        .unwrap();

    assert_eq!(result["status"], "blocked");
    assert_eq!(
        result["preflight"]["code"],
        "HTTP2_BODY_REWRITE_UNSUPPORTED"
    );
    assert_eq!(result["preflight"]["savedHttp2Enabled"], false);
    assert_eq!(result["preflight"]["runtimeHttp2Enabled"], true);
    assert_eq!(result["preflight"]["evidenceSessionId"], SOURCE);
    assert!(state.read_rewrite_manager().list_rules().is_empty());
    assert_eq!(
        state
            .lock_db_for_ipc()
            .unwrap()
            .query_row("SELECT count(*) FROM automation_change_sets", [], |row| row
                .get::<_, i64>(0),)
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn prior_listener_http2_and_replay_are_excluded_from_current_evidence() {
    let harness = test_harness();
    let state = &harness.state;
    capture(
        state,
        SOURCE,
        EXAMPLE_URL,
        "2",
        "2020-01-01T00:00:00Z",
        "proxy",
    )
    .await;
    state.start_proxy(8888, true, false, WORKSPACE_ID.to_owned());
    capture(
        state,
        "replayed-session",
        EXAMPLE_URL,
        "2",
        &Utc::now().to_rfc3339(),
        "agentReplay",
    )
    .await;
    let result = state
        .create_session_json_rewrite(
            params(SessionJsonRewriteMode::Preview),
            CLIENT,
            automation_permissions(),
        )
        .await
        .unwrap();

    assert_eq!(result["status"], "ready");
    assert_eq!(result["preflight"]["runtimeHttp2Enabled"], false);
    assert!(result["preflight"]["evidenceSessionId"].is_null());
    assert!(state.read_rewrite_manager().list_rules().is_empty());
}

#[tokio::test]
async fn http2_enabled_without_current_evidence_warns_and_preview_is_read_only() {
    let harness = test_harness();
    let state = &harness.state;
    capture(
        state,
        SOURCE,
        EXAMPLE_URL,
        "2",
        "2020-01-01T00:00:00Z",
        "proxy",
    )
    .await;
    state.start_proxy(8888, true, true, WORKSPACE_ID.to_owned());

    let result = state
        .create_session_json_rewrite(
            params(SessionJsonRewriteMode::Preview),
            CLIENT,
            automation_permissions(),
        )
        .await
        .unwrap();

    assert_eq!(result["status"], "ready");
    assert_eq!(
        result["preflight"]["warnings"],
        json!(["HTTP2_MAY_SKIP_BODY_REWRITE"])
    );
    assert!(state.read_rewrite_manager().list_rules().is_empty());
}

#[tokio::test]
async fn create_then_repeat_preserves_the_rule_and_deadline() {
    let harness = test_harness();
    let state = &harness.state;
    capture(
        state,
        SOURCE,
        EXAMPLE_URL,
        "2",
        "2020-01-01T00:00:00Z",
        "proxy",
    )
    .await;
    state.start_proxy(8888, true, false, WORKSPACE_ID.to_owned());

    let request = params(SessionJsonRewriteMode::Create);
    let first = state
        .create_session_json_rewrite(request.clone(), CLIENT, automation_permissions())
        .await
        .unwrap();
    let repeated = state
        .create_session_json_rewrite(request.clone(), CLIENT, automation_permissions())
        .await
        .unwrap();
    assert_eq!(first["status"], "active");
    assert_eq!(first["verification"]["status"], "pending");
    assert_eq!(
        first["match"]["queryParams"],
        json!({"_method": "site.get_mydeals_drawer"})
    );
    assert_eq!(repeated["ruleId"], first["ruleId"]);
    assert_eq!(repeated["expiresAt"], first["expiresAt"]);
    assert_eq!(repeated["idempotent"], true);
    let activated = parse_time(first["activatedAt"].as_str().unwrap()).unwrap();
    let expiry = parse_time(first["expiresAt"].as_str().unwrap()).unwrap();
    assert_eq!(expiry - activated, chrono::Duration::seconds(600));
    assert_eq!(state.read_rewrite_manager().list_rules().len(), 1);

    let changed = CreateSessionJsonRewriteParams {
        value: json!("1"),
        ..request
    };
    let error = state
        .create_session_json_rewrite(changed, CLIENT, automation_permissions())
        .await
        .unwrap_err();
    assert_eq!(error.code, "IDEMPOTENCY_CONFLICT");
}

#[tokio::test]
async fn failed_activation_removes_the_unpublished_resource() {
    let harness = test_harness();
    let state = &harness.state;
    capture(
        state,
        SOURCE,
        EXAMPLE_URL,
        "1.1",
        "2020-01-01T00:00:00Z",
        "proxy",
    )
    .await;
    state.start_proxy(8888, true, false, WORKSPACE_ID.to_owned());
    state
        .lock_db_for_ipc()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_activation BEFORE UPDATE OF status ON automation_change_sets
         WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'test activation failure'); END;",
        )
        .unwrap();

    let error = state
        .create_session_json_rewrite(
            params(SessionJsonRewriteMode::Create),
            CLIENT,
            automation_permissions(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, "RUNTIME_PUBLISH_FAILED");
    assert!(state.read_rewrite_manager().list_rules().is_empty());
    let conn = state.lock_db_for_ipc().unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM automation_resources", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT status FROM automation_change_sets", [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap(),
        "aborted"
    );
}

#[tokio::test]
async fn temporary_rewrite_requires_manage_automation_permission() {
    let harness = test_harness();
    let error = harness
        .state
        .create_session_json_rewrite(
            params(SessionJsonRewriteMode::Create),
            CLIENT,
            AutomationPermissions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "CONTROL_PERMISSION_DENIED");
}

#[test]
fn query_scope_requires_explicit_discriminator_when_default_is_unavailable() {
    let url = Url::parse("https://api.example.test/api/?method=drawer&timestamp=1").unwrap();
    assert_eq!(
        resolve_query_keys(&url, None).unwrap().unwrap_err(),
        ["method", "timestamp"]
    );
    assert!(resolve_query_keys(&url, Some(&[]))
        .unwrap()
        .unwrap()
        .is_empty());
    let keys = ["method".to_owned()];
    assert_eq!(
        resolve_query_keys(&url, Some(&keys)).unwrap().unwrap()["method"],
        "drawer"
    );
    let duplicate =
        Url::parse("https://api.example.test/api/?method=drawer&method=launch").unwrap();
    assert_eq!(
        resolve_query_keys(&duplicate, Some(&keys))
            .unwrap_err()
            .code,
        "QUERY_PARAM_INVALID"
    );
}

#[tokio::test]
async fn live_http1_rewrites_only_the_matching_field_until_expiry() {
    let harness = test_harness();
    let state = &harness.state;
    let upstream = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let origin = format!("http://{}", upstream.local_addr().unwrap());
    let captured_url = format!("{origin}/api/?_method=site.get_mydeals_drawer&_timestamp=before");
    capture(
        state,
        SOURCE,
        &captured_url,
        "2",
        "2020-01-01T00:00:00Z",
        "proxy",
    )
    .await;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let proxy_port = listener.local_addr().unwrap().port();
    drop(listener);
    state.start_proxy(proxy_port, false, false, WORKSPACE_ID.to_owned());
    let changed = state
        .create_session_json_rewrite(
            params(SessionJsonRewriteMode::Create),
            CLIENT,
            automation_permissions(),
        )
        .await
        .unwrap();
    assert_eq!(changed["status"], "active");
    let other_workspace = evaluate_offline(
        OfflineEvaluationInput {
            workspace_id: "other-workspace".to_owned(),
            request: OfflineRequestInput {
                method: "POST".to_owned(),
                url: captured_url,
                headers: Vec::new(),
                body_base64: None,
            },
            baseline_response: Some(OfflineResponseInput {
                status: 200,
                headers: Vec::new(),
                body_base64: Some(BASE64_STANDARD.encode(BODY)),
            }),
        },
        state.read_rewrite_manager(),
        state.read_map_manager(),
    )
    .unwrap();
    assert!(other_workspace.rewrite_traces.is_empty());

    let upstream_task = tokio::spawn(async move {
        for body in [BODY, BODY, BODY, r#"{"other":0}"#, BODY] {
            let (mut client, _) = upstream.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(client.read_u8().await.unwrap());
            }
            client.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ).as_bytes()).await.unwrap();
        }
    });
    let mut proxy = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
                http2_enabled: Some(false),
                verify_upstream_tls: false,
                tls_verify_hosts: Arc::from([]),
                ssl_blind_hosts: Arc::from([]),
                upstream_proxy: None,
                ssl_proxying: None,
            },
            workspace_id: Some(WORKSPACE_ID.to_owned()),
            event_emitter: None,
        },
        ProxyManagers {
            tls: None,
            breakpoint: None,
            rewrite: Some(state.read_rewrite_manager()),
            map: Some(state.read_map_manager()),
            script: None,
            throttle: None,
            dns: None,
        },
    )
    .await
    .unwrap();

    let target =
        format!("{origin}/api/?_timestamp=after&_method=site.get_mydeals_drawer&first_launch=0");
    let wait = state.wait_for_session_json_rewrite(
        WaitForSessionJsonRewriteParams {
            change_id: changed["changeId"].as_str().unwrap().to_owned(),
            after_rowid: None,
            timeout_ms: 2000,
        },
        automation_permissions(),
    );
    let client = async {
        let body = request_through_proxy(proxy_port, "POST", &target).await;
        let completed = completed_session(&mut proxy).await;
        state.upsert_session_async(completed.clone()).await;
        (body, completed)
    };
    let (verified, (body, completed)) = tokio::join!(wait, client);
    assert_eq!(
        body,
        BODY.replace("hide_user_name\":0", "hide_user_name\":1")
    );
    let verified = verified.unwrap();
    assert_eq!(verified["status"], "verified");
    assert_eq!(verified["sessionId"], completed.id);
    assert_eq!(verified["assertion"]["actual"], 1);
    assert_eq!(verified["assertion"]["expected"], 1);
    assert_eq!(verified["ruleTrace"]["outcome"], "success");
    assert_eq!(completed.summary.http_version, "1.1");
    assert_eq!(
        completed.rewrite_traces[0].rule_id,
        changed["ruleId"].as_str().unwrap()
    );
    assert_eq!(
        completed.rewrite_traces[0].entries[0].before.as_deref(),
        Some("0")
    );
    assert_eq!(
        completed.rewrite_traces[0].entries[0].after.as_deref(),
        Some("1")
    );

    let other_endpoint = format!("{origin}/api/?_method=app.launch");
    assert_eq!(
        request_through_proxy(proxy_port, "POST", &other_endpoint).await,
        BODY
    );
    assert!(completed_session(&mut proxy)
        .await
        .rewrite_traces
        .is_empty());
    assert_eq!(
        request_through_proxy(proxy_port, "GET", &target).await,
        BODY
    );
    assert!(completed_session(&mut proxy)
        .await
        .rewrite_traces
        .is_empty());

    assert_eq!(
        request_through_proxy(proxy_port, "POST", &target).await,
        r#"{"other":0}"#
    );
    let skipped = completed_session(&mut proxy).await;
    assert_eq!(skipped.rewrite_traces[0].outcome, "skipped");
    assert_eq!(skipped.rewrite_traces[0].entries[0].kind, "skip");

    let deadline = Utc::now() - chrono::Duration::seconds(1);
    state
        .lock_db_for_ipc()
        .unwrap()
        .execute(
            "UPDATE automation_change_sets SET expires_at=?1 WHERE id=?2",
            [
                deadline.to_rfc3339().as_str(),
                changed["changeId"].as_str().unwrap(),
            ],
        )
        .unwrap();
    state.republish_automation_runtime().unwrap();
    assert_eq!(
        request_through_proxy(proxy_port, "POST", &target).await,
        BODY
    );
    assert!(completed_session(&mut proxy)
        .await
        .rewrite_traces
        .is_empty());

    proxy.server_handle.shutdown().await;
    upstream_task.await.unwrap();
}

async fn request_through_proxy(port: u16, method: &str, target: &str) -> String {
    timeout(Duration::from_secs(5), async {
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let url = Url::parse(target).unwrap();
        let host = format!("{}:{}", url.host_str().unwrap(), url.port().unwrap());
        client.write_all(format!(
            "{method} {target} HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        ).as_bytes()).await.unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("HTTP/1.1 200 "), "{headers}");
        body.to_owned()
    }).await.unwrap()
}

async fn completed_session(
    proxy: &mut aiproxy_proxy_core::StartedProxyServer,
) -> aiproxy_proxy_core::ProxySessionDetail {
    timeout(Duration::from_secs(5), async {
        loop {
            let session = proxy.session_receiver.recv().await.unwrap();
            if session.summary.status_code > 0 {
                return session;
            }
        }
    })
    .await
    .unwrap()
}
