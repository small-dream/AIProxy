use super::rules::{
    active_throttle_profile_for_workspace, apply_map_rules, apply_request_rewrite_rules,
    apply_response_rewrite_rules,
};
use super::{
    apply_request_resolution, apply_response_resolution, build_raw_http_head, build_request_path,
    build_upstream_headers_from_entries, find_header_end, infer_protocol_metadata,
    override_upstream_request_timeout_for_test, resolve_target_url, send_direct_request,
    start_proxy_server, BreakpointActionKind, BreakpointResolution, MapManager, MapRule,
    ParsedProxyRequest, ProxyBodyReference, ProxyConfig, ProxyHeaderEntry, ProxyManagers,
    ProxyRuntimeConfig, ProxySessionDetail, ProxySessionSummary, ProxyTimingBreakdown,
    RewriteManager, RewriteRule, RewriteRuleMatch, StartedProxyServer, ThrottleManager,
    ThrottleProfileData, UpstreamResponse, MAX_CAPTURED_BODY_BYTES,
};
use http::header::{HeaderMap, HeaderValue};
use http::{Method, StatusCode};
use serde_json::json;
use std::{fs, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use url::Url;

#[test]
fn validates_a_non_zero_port() {
    let config = ProxyRuntimeConfig {
        port: 8888,
        ssl_enabled: true,
        http2_enabled: None,
    };

    let actual = config.validate();

    assert_eq!(actual, Ok(()));
}

#[test]
fn rejects_zero_as_a_port() {
    let config = ProxyRuntimeConfig {
        port: 0,
        ssl_enabled: false,
        http2_enabled: None,
    };

    let actual = config.validate();

    assert_eq!(actual, Err("proxy port must be greater than zero"));
}

#[test]
fn finds_the_end_of_the_http_header_block() {
    let actual = find_header_end(b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\nbody");

    assert_eq!(actual, Some(37));
}

#[test]
fn resolves_origin_form_requests_from_the_host_header() {
    let headers = [httparse::Header {
        name: "Host",
        value: b"example.com",
    }];

    let actual = resolve_target_url("/hello", &headers);

    assert_eq!(actual, Ok("http://example.com/hello".to_string()));
}

#[test]
fn keeps_absolute_form_requests_unchanged() {
    let actual = resolve_target_url("http://example.com/hello", &[]);

    assert_eq!(actual, Ok("http://example.com/hello".to_string()));
}

#[test]
fn builds_a_request_path_with_the_query_string() {
    let actual = build_request_path(&Url::parse("http://example.com/hello?lang=en").unwrap());

    assert_eq!(actual, "/hello?lang=en");
}

#[test]
fn infers_protocol_metadata_from_legacy_protocol_and_url() {
    let https = infer_protocol_metadata("https", "https://api.example.com/users");
    assert_eq!(https.scheme, "https");
    assert_eq!(https.http_version, "1.1");
    assert_eq!(https.transport_protocol, "tcp");
    assert_eq!(https.application_protocol, "http");

    let websocket = infer_protocol_metadata("wss", "wss://api.example.com/socket");
    assert_eq!(websocket.scheme, "https");
    assert_eq!(websocket.http_version, "1.1");
    assert_eq!(websocket.transport_protocol, "tcp");
    assert_eq!(websocket.application_protocol, "websocket");

    let h2 = infer_protocol_metadata("h2", "https://api.example.com/users");
    assert_eq!(h2.scheme, "https");
    assert_eq!(h2.http_version, "2");
    assert_eq!(h2.transport_protocol, "tcp");
    assert_eq!(h2.application_protocol, "http");
}

#[test]
fn applies_breakpoint_request_query_edits_to_runtime_request() {
    let mut request = ParsedProxyRequest {
        body: Vec::new(),
        client_address: None,
        headers: HeaderMap::new(),
        host: "example.com".to_string(),
        method: Method::GET,
        path: "/hello?lang=en".to_string(),
        protocol: "http".to_string(),
        query_params: vec![ProxyHeaderEntry {
            name: "lang".to_string(),
            value: "en".to_string(),
            is_pseudo: None,
        }],
        raw_request: build_raw_http_head("GET /hello?lang=en HTTP/1.1", &[]),
        request_headers: Vec::new(),
        request_id: "request-1".to_string(),
        url: Url::parse("http://example.com/hello?lang=en").unwrap(),
        tls_cipher_suite: None,
        tls_protocol: None,
    };
    let resolution = BreakpointResolution {
        action: BreakpointActionKind::Forward,
        mock: None,
        modified_request_body_base64: None,
        modified_request_headers: None,
        modified_request_query_params: Some(vec![
            ProxyHeaderEntry {
                name: "lang".to_string(),
                value: "zh".to_string(),
                is_pseudo: None,
            },
            ProxyHeaderEntry {
                name: "debug".to_string(),
                value: "1".to_string(),
                is_pseudo: None,
            },
        ]),
        modified_response_body_base64: None,
        modified_response_headers: None,
        modified_response_status_code: None,
        session_id: "request-1".to_string(),
    };

    apply_request_resolution(&resolution, &mut request);

    assert_eq!(
        request.url.as_str(),
        "http://example.com/hello?lang=zh&debug=1"
    );
    assert_eq!(request.path, "/hello?lang=zh&debug=1");
    assert_eq!(
        request.query_params,
        vec![
            ProxyHeaderEntry {
                name: "lang".to_string(),
                value: "zh".to_string(),
                is_pseudo: None,
            },
            ProxyHeaderEntry {
                name: "debug".to_string(),
                value: "1".to_string(),
                is_pseudo: None,
            },
        ]
    );
    assert!(request
        .raw_request
        .starts_with("GET /hello?lang=zh&debug=1 HTTP/1.1"));
}

#[test]
fn applies_breakpoint_response_status_edits() {
    let mut response = UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        dns_ms: 0,
        request_send_ms: 0,
        response_body: b"{}".to_vec(),
        response_body_size_bytes: 2,
        response_headers: HeaderMap::new(),
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::OK,
        tls_ms: None,
        waiting_ms: 0,
    };
    response
        .response_headers
        .insert("content-type", HeaderValue::from_static("application/json"));
    let resolution = BreakpointResolution {
        action: BreakpointActionKind::Forward,
        mock: None,
        modified_request_body_base64: None,
        modified_request_headers: None,
        modified_request_query_params: None,
        modified_response_body_base64: None,
        modified_response_headers: None,
        modified_response_status_code: Some(418),
        session_id: "request-1".to_string(),
    };

    apply_response_resolution(&resolution, &mut response);

    assert_eq!(response.status_code, StatusCode::IM_A_TEAPOT);
}

#[test]
fn applies_breakpoint_response_body_edits_as_plain_body() {
    let mut response = UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        dns_ms: 0,
        request_send_ms: 0,
        response_body: b"original".to_vec(),
        response_body_size_bytes: 8,
        response_headers: HeaderMap::new(),
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::OK,
        tls_ms: None,
        waiting_ms: 0,
    };
    response
        .response_headers
        .insert("content-type", HeaderValue::from_static("application/json"));
    response
        .response_headers
        .insert("content-encoding", HeaderValue::from_static("gzip"));
    response
        .response_headers
        .insert("content-md5", HeaderValue::from_static("stale"));
    response
        .response_headers
        .insert("digest", HeaderValue::from_static("sha-256=stale"));
    response
        .response_headers
        .insert("etag", HeaderValue::from_static("\"stale\""));
    let resolution = BreakpointResolution {
        action: BreakpointActionKind::Forward,
        mock: None,
        modified_request_body_base64: None,
        modified_request_headers: None,
        modified_request_query_params: None,
        modified_response_body_base64: Some("eyJlZGl0ZWQiOnRydWV9".to_string()),
        modified_response_headers: None,
        modified_response_status_code: None,
        session_id: "request-1".to_string(),
    };

    apply_response_resolution(&resolution, &mut response);

    assert_eq!(response.response_body, br#"{"edited":true}"#);
    assert_eq!(response.response_body_size_bytes, 15);
    assert!(response.response_headers.contains_key("content-type"));
    assert!(!response.response_headers.contains_key("content-encoding"));
    assert!(!response.response_headers.contains_key("content-md5"));
    assert!(!response.response_headers.contains_key("digest"));
    assert!(!response.response_headers.contains_key("etag"));
}

#[test]
fn serializes_body_references_on_demand() {
    let body = ProxyBodyReference::from_decoded_bytes(
        br#"{"ok":true}"#.to_vec(),
        Some("application/json".to_string()),
        11,
        false,
        true,
    );

    let actual = serde_json::to_value(&body).unwrap();

    assert_eq!(actual["inlineText"], json!(r#"{"ok":true}"#));
    assert_eq!(actual["encoding"], json!("utf-8"));
    assert_eq!(actual["mimeType"], json!("application/json"));
    assert_eq!(actual["sizeBytes"], json!(11));
    assert_eq!(actual["base64Text"], json!("eyJvayI6dHJ1ZX0="));
}

#[test]
fn serializes_raw_messages_from_heads_and_body_references() {
    let detail = ProxySessionDetail {
        client_address: Some("127.0.0.1:54321".to_string()),
        cookies: Vec::new(),
        id: "session-1".to_string(),
        query_params: Vec::new(),
        raw_request_head: Some(build_raw_http_head(
            "POST /hello HTTP/1.1",
            &[ProxyHeaderEntry {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
                is_pseudo: None,
            }],
        )),
        raw_response_head: Some(build_raw_http_head(
            "HTTP/1.1 200 OK",
            &[ProxyHeaderEntry {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
                is_pseudo: None,
            }],
        )),
        request_body: Some(ProxyBodyReference::from_decoded_bytes(
            br#"{"hello":"world"}"#.to_vec(),
            Some("application/json".to_string()),
            17,
            false,
            true,
        )),
        request_headers: vec![ProxyHeaderEntry {
            name: "Content-Type".to_string(),
            value: "application/json".to_string(),
            is_pseudo: None,
        }],
        response_body: Some(ProxyBodyReference::from_decoded_bytes(
            br#"{"ok":true}"#.to_vec(),
            Some("application/json".to_string()),
            11,
            false,
            true,
        )),
        response_headers: vec![ProxyHeaderEntry {
            name: "Content-Type".to_string(),
            value: "application/json".to_string(),
            is_pseudo: None,
        }],
        map_traces: Vec::new(),
        rewrite_traces: Vec::new(),
        server_ip: None,
        summary: ProxySessionSummary {
            id: "session-1".to_string(),
            method: "POST".to_string(),
            host: "example.com".to_string(),
            path: "/hello".to_string(),
            protocol: "http".to_string(),
            scheme: "http".to_string(),
            http_version: "1.1".to_string(),
            transport_protocol: "tcp".to_string(),
            application_protocol: "http".to_string(),
            started_at: "2026-04-21T00:00:00Z".to_string(),
            finished_at: "2026-04-21T00:00:01Z".to_string(),
            duration_ms: 1,
            size_bytes: 11,
            status_code: 200,
            url: "http://example.com/hello".to_string(),
            response_mime_type: Some("application/json".to_string()),
        },
        script_traces: Vec::new(),
        throttle_traces: Vec::new(),
        tls_cipher_suite: Some("TLS_AES_128_GCM_SHA256".to_string()),
        tls_protocol: Some("TLSv1.3".to_string()),
        timing: Some(ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: None,
            response_read_ms: Some(1),
            tls_ms: None,
            total_ms: Some(1),
            waiting_ms: Some(1),
        }),
        timing_source: None,
        trailers: None,
        h2_stream_id: None,
    };

    let actual = serde_json::to_value(&detail).unwrap();

    assert_eq!(
        actual["rawRequest"],
        json!(
            "POST /hello HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{\"hello\":\"world\"}"
        )
    );
    assert_eq!(actual["clientAddress"], json!("127.0.0.1:54321"));
    assert_eq!(actual["tlsProtocol"], json!("TLSv1.3"));
    assert_eq!(actual["tlsCipherSuite"], json!("TLS_AES_128_GCM_SHA256"));
    assert_eq!(
        actual["rawResponse"],
        json!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}")
    );
    assert_eq!(
        actual["requestBody"]["inlineText"],
        json!(r#"{"hello":"world"}"#)
    );
    assert_eq!(
        actual["responseBody"]["inlineText"],
        json!(r#"{"ok":true}"#)
    );
    assert_eq!(actual["timing"]["responseReadMs"], json!(1));
    assert!(actual["timing"].get("response_read_ms").is_none());
}

#[test]
fn applies_request_rewrite_rules_to_the_runtime_request() {
    let manager = RewriteManager::new();
    manager.save_rule(RewriteRule {
        id: "rewrite-header".to_string(),
        enabled: true,
        name: "Rewrite request".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec!["GET".to_string()],
            stage: "request".to_string(),
            url_pattern: "example.com".to_string(),
            match_type: None,
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({
            "headerName": "x-debug-mode",
            "operation": "set",
            "target": "request",
            "value": "true"
        }),
    });
    manager.save_rule(RewriteRule {
        id: "rewrite-query".to_string(),
        enabled: true,
        name: "Set query".to_string(),
        note: None,
        priority: 9,
        r#match: RewriteRuleMatch {
            methods: vec!["GET".to_string()],
            stage: "request".to_string(),
            url_pattern: "example.com".to_string(),
            match_type: None,
        },
        rewrite_type: "query".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({
            "operation": "set",
            "paramName": "env",
            "value": "staging"
        }),
    });
    manager.save_rule(RewriteRule {
        id: "rewrite-redirect".to_string(),
        enabled: true,
        name: "Redirect upstream".to_string(),
        note: None,
        priority: 8,
        r#match: RewriteRuleMatch {
            methods: vec!["GET".to_string()],
            stage: "request".to_string(),
            url_pattern: "example.com".to_string(),
            match_type: None,
        },
        rewrite_type: "redirect".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({
            "preservePath": true,
            "preserveQuery": true,
            "targetUrl": "https://staging.example.com"
        }),
    });

    let mut request = build_test_request("http://example.com/api/users?lang=en");

    let traces =
        apply_request_rewrite_rules(&Some(Arc::new(manager)), "default", &mut request, false)
            .unwrap();

    assert_eq!(
        request.url.as_str(),
        "https://staging.example.com/api/users?lang=en&env=staging"
    );
    assert_eq!(request.protocol, "https");
    assert_eq!(request.host, "staging.example.com");
    assert!(request
        .request_headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case("x-debug-mode") && header.value == "true"));
    assert_eq!(traces.len(), 3);
    assert!(traces.iter().any(|trace| trace.rewrite_type == "redirect"));
}

#[test]
fn applies_request_body_rewrite_as_plain_body() {
    let manager = RewriteManager::new();
    manager.save_rule(RewriteRule {
        id: "rewrite-request-body".to_string(),
        enabled: true,
        name: "Rewrite request body".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec!["GET".to_string()],
            stage: "request".to_string(),
            url_pattern: "example.com".to_string(),
            match_type: None,
        },
        rewrite_type: "body".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({
            "contentType": "application/json",
            "target": "request",
            "text": "{\"edited\":true}"
        }),
    });

    let mut request = build_test_request("http://example.com/api/users");
    request.body = b"original".to_vec();
    request.request_headers.push(ProxyHeaderEntry {
        name: "Content-Encoding".to_string(),
        value: "gzip".to_string(),
        is_pseudo: None,
    });
    request.request_headers.push(ProxyHeaderEntry {
        name: "Content-MD5".to_string(),
        value: "stale".to_string(),
        is_pseudo: None,
    });
    request.request_headers.push(ProxyHeaderEntry {
        name: "Digest".to_string(),
        value: "sha-256=stale".to_string(),
        is_pseudo: None,
    });
    request.request_headers.push(ProxyHeaderEntry {
        name: "ETag".to_string(),
        value: "\"stale\"".to_string(),
        is_pseudo: None,
    });
    request.headers = build_upstream_headers_from_entries(&request.request_headers).unwrap();

    let traces =
        apply_request_rewrite_rules(&Some(Arc::new(manager)), "default", &mut request, false)
            .unwrap();

    assert_eq!(request.body, br#"{"edited":true}"#);
    assert_eq!(
        header_entry(&request.request_headers, "content-type"),
        Some("application/json")
    );
    assert_eq!(
        header_entry(&request.request_headers, "content-encoding"),
        None
    );
    assert_eq!(header_entry(&request.request_headers, "content-md5"), None);
    assert_eq!(header_entry(&request.request_headers, "digest"), None);
    assert_eq!(header_entry(&request.request_headers, "etag"), None);
    assert!(!request.headers.contains_key("content-encoding"));
    assert_eq!(traces.len(), 1);
}

#[test]
fn applies_response_body_rewrite_as_plain_body() {
    let manager = RewriteManager::new();
    manager.save_rule(RewriteRule {
        id: "rewrite-response-body".to_string(),
        enabled: true,
        name: "Rewrite response body".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec!["GET".to_string()],
            stage: "response".to_string(),
            url_pattern: "example.com".to_string(),
            match_type: None,
        },
        rewrite_type: "body".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({
            "contentType": "application/json",
            "target": "response",
            "text": "{\"edited\":true}"
        }),
    });

    let request = build_test_request("http://example.com/api/users");
    let mut response = UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        dns_ms: 0,
        request_send_ms: 0,
        response_body: b"original".to_vec(),
        response_body_size_bytes: 8,
        response_headers: HeaderMap::new(),
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::OK,
        tls_ms: None,
        waiting_ms: 0,
    };
    response
        .response_headers
        .insert("content-type", HeaderValue::from_static("text/plain"));
    response
        .response_headers
        .insert("content-encoding", HeaderValue::from_static("gzip"));
    response
        .response_headers
        .insert("content-md5", HeaderValue::from_static("stale"));
    response
        .response_headers
        .insert("digest", HeaderValue::from_static("sha-256=stale"));
    response
        .response_headers
        .insert("etag", HeaderValue::from_static("\"stale\""));

    let traces = apply_response_rewrite_rules(
        &Some(Arc::new(manager)),
        "default",
        &request,
        &mut response,
        false,
    )
    .unwrap();

    assert_eq!(response.response_body, br#"{"edited":true}"#);
    assert_eq!(response.response_body_size_bytes, 15);
    assert_eq!(
        response
            .response_headers
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    assert!(!response.response_headers.contains_key("content-encoding"));
    assert!(!response.response_headers.contains_key("content-md5"));
    assert!(!response.response_headers.contains_key("digest"));
    assert!(!response.response_headers.contains_key("etag"));
    assert_eq!(traces.len(), 1);
}

#[test]
fn applies_request_body_rewrite_to_json_fields() {
    let manager = RewriteManager::new();
    manager.save_rule(RewriteRule {
        id: "rewrite-request-body-fields".to_string(),
        enabled: true,
        name: "Rewrite request body fields".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec!["POST".to_string()],
            stage: "request".to_string(),
            url_pattern: "example.com".to_string(),
            match_type: None,
        },
        rewrite_type: "body".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({
            "contentType": "application/json",
            "fields": [
                { "operation": "set", "path": "user.name", "value": "Jane", "valueType": "string" },
                { "operation": "set", "path": "user.enabled", "value": "true", "valueType": "boolean" },
                { "operation": "remove", "path": "debug" }
            ],
            "mode": "fields",
            "target": "request",
            "text": ""
        }),
    });

    let mut request = build_test_request("http://example.com/api/users");
    request.method = Method::POST;
    request.body = br#"{"user":{"name":"Jake"},"debug":true}"#.to_vec();
    request.request_headers.push(ProxyHeaderEntry {
        name: "Content-Encoding".to_string(),
        value: "gzip".to_string(),
        is_pseudo: None,
    });
    request.headers = build_upstream_headers_from_entries(&request.request_headers).unwrap();

    let traces =
        apply_request_rewrite_rules(&Some(Arc::new(manager)), "default", &mut request, false)
            .unwrap();
    let rewritten: serde_json::Value = serde_json::from_slice(&request.body).unwrap();

    assert_eq!(
        rewritten,
        json!({ "user": { "name": "Jane", "enabled": true } })
    );
    assert_eq!(
        header_entry(&request.request_headers, "content-type"),
        Some("application/json")
    );
    assert_eq!(
        header_entry(&request.request_headers, "content-encoding"),
        None
    );
    assert_eq!(traces[0].entries.len(), 3);
    assert_eq!(traces[0].entries[0].kind, "body-field");
}

#[test]
fn applies_response_body_rewrite_to_json_array_fields() {
    let manager = RewriteManager::new();
    manager.save_rule(RewriteRule {
        id: "rewrite-response-body-fields".to_string(),
        enabled: true,
        name: "Rewrite response body fields".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec!["GET".to_string()],
            stage: "response".to_string(),
            url_pattern: "example.com".to_string(),
            match_type: None,
        },
        rewrite_type: "body".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({
            "contentType": "application/json",
            "fields": [
                { "operation": "set", "path": "$.items[0].name", "value": "\"mocked\"", "valueType": "json" },
                { "operation": "set", "path": "items[1].count", "value": "9", "valueType": "number" }
            ],
            "mode": "fields",
            "target": "response",
            "text": ""
        }),
    });

    let request = build_test_request("http://example.com/api/users");
    let mut response = UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        dns_ms: 0,
        request_send_ms: 0,
        response_body: br#"{"items":[{"name":"original"},{"count":1}]}"#.to_vec(),
        response_body_size_bytes: 41,
        response_headers: HeaderMap::new(),
        response_read_ms: 0,
        spooled_response_path: None,
        status_code: StatusCode::OK,
        tls_ms: None,
        waiting_ms: 0,
    };

    let traces = apply_response_rewrite_rules(
        &Some(Arc::new(manager)),
        "default",
        &request,
        &mut response,
        false,
    )
    .unwrap();
    let rewritten: serde_json::Value = serde_json::from_slice(&response.response_body).unwrap();

    assert_eq!(
        rewritten,
        json!({ "items": [{ "name": "mocked" }, { "count": 9.0 }] })
    );
    assert_eq!(
        response.response_body_size_bytes,
        response.response_body.len()
    );
    assert_eq!(
        response
            .response_headers
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    assert_eq!(traces[0].entries.len(), 2);
}

#[test]
fn rewrite_rule_respects_match_type_exact() {
    let manager = Arc::new(RewriteManager::new());
    manager.save_rule(RewriteRule {
        id: "exact-rule".to_string(),
        enabled: true,
        name: "Exact match".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec![],
            stage: "request".to_string(),
            url_pattern: "https://api.example.com/v1/users".to_string(),
            match_type: Some("exact".to_string()),
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({"headerName":"x-test","operation":"set","target":"request","value":"1"}),
    });

    // exact URL should match
    let mut request = build_test_request("https://api.example.com/v1/users");
    let traces =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request, false)
            .unwrap();
    assert_eq!(traces.len(), 1);

    // different path should NOT match
    let mut request2 = build_test_request("https://api.example.com/v1/other");
    let traces2 =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request2, false)
            .unwrap();
    assert!(traces2.is_empty());
}

#[test]
fn rewrite_rule_respects_match_type_regex() {
    let manager = Arc::new(RewriteManager::new());
    manager.save_rule(RewriteRule {
        id: "regex-rule".to_string(),
        enabled: true,
        name: "Regex match".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec![],
            stage: "request".to_string(),
            url_pattern: r"https://api\.example\.com/v1/users\?env=staging".to_string(),
            match_type: Some("regex".to_string()),
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({"headerName":"x-test","operation":"set","target":"request","value":"1"}),
    });

    let mut request = build_test_request("https://api.example.com/v1/users?env=staging&lang=en");
    let traces =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request, false)
            .unwrap();
    assert_eq!(traces.len(), 1);

    let mut request2 = build_test_request("https://api.example.com/v1/users?env=prod");
    let traces2 =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request2, false)
            .unwrap();
    assert!(traces2.is_empty());
}

#[test]
fn invalid_regex_rule_is_skipped_gracefully() {
    let manager = Arc::new(RewriteManager::new());
    // Save a rule with an invalid regex pattern — it should not panic,
    // and should simply be skipped during matching.
    manager.save_rule(RewriteRule {
        id: "bad-regex".to_string(),
        enabled: true,
        name: "Bad regex".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec![],
            stage: "request".to_string(),
            url_pattern: "[invalid(regex".to_string(),
            match_type: Some("regex".to_string()),
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({"headerName":"x-test","operation":"set","target":"request","value":"1"}),
    });

    let mut request = build_test_request("https://example.com/anything");
    let traces =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request, false)
            .unwrap();
    // Invalid regex rule should be skipped, not crash.
    assert!(traces.is_empty());
}

#[test]
fn compiled_regex_refreshes_after_rule_update() {
    let manager = Arc::new(RewriteManager::new());
    // Initially save a rule matching "staging"
    manager.save_rule(RewriteRule {
        id: "refresh-test".to_string(),
        enabled: true,
        name: "Refresh test".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec![],
            stage: "request".to_string(),
            url_pattern: r"staging".to_string(),
            match_type: Some("regex".to_string()),
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({"headerName":"x-test","operation":"set","target":"request","value":"1"}),
    });

    let mut request1 = build_test_request("https://staging.example.com/api");
    let traces1 =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request1, false)
            .unwrap();
    assert_eq!(traces1.len(), 1, "should match 'staging' pattern");

    // Update the same rule to match "production" instead
    manager.save_rule(RewriteRule {
        id: "refresh-test".to_string(),
        enabled: true,
        name: "Refresh test".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec![],
            stage: "request".to_string(),
            url_pattern: r"production".to_string(),
            match_type: Some("regex".to_string()),
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({"headerName":"x-test","operation":"set","target":"request","value":"2"}),
    });

    // Old URL should no longer match
    let mut request2 = build_test_request("https://staging.example.com/api");
    let traces2 =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request2, false)
            .unwrap();
    assert!(
        traces2.is_empty(),
        "old pattern should not match after update"
    );

    // New URL should match
    let mut request3 = build_test_request("https://production.example.com/api");
    let traces3 =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request3, false)
            .unwrap();
    assert_eq!(traces3.len(), 1, "new pattern should match after update");
}

#[test]
fn non_regex_match_types_do_not_compile_regex() {
    let manager = Arc::new(RewriteManager::new());
    // Save a rule with match_type "contains" (not "regex")
    manager.save_rule(RewriteRule {
        id: "contains-rule".to_string(),
        enabled: true,
        name: "Contains test".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec![],
            stage: "request".to_string(),
            url_pattern: "example.com".to_string(),
            match_type: Some("contains".to_string()),
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({"headerName":"x-test","operation":"set","target":"request","value":"1"}),
    });

    // Save another with match_type "exact"
    manager.save_rule(RewriteRule {
        id: "exact-rule".to_string(),
        enabled: true,
        name: "Exact test".to_string(),
        note: None,
        priority: 5,
        r#match: RewriteRuleMatch {
            methods: vec![],
            stage: "request".to_string(),
            url_pattern: "https://exact.example.com/path".to_string(),
            match_type: Some("exact".to_string()),
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({"headerName":"x-test","operation":"set","target":"request","value":"2"}),
    });

    // Verify compiled_rules has None for compiled_match on non-regex rules
    let compiled = manager.compiled_rules();
    assert!(
        compiled.iter().all(|cr| cr.compiled_match.is_none()),
        "non-regex rules should have no compiled regex"
    );

    // But the rules should still match correctly via pattern_matches fallback
    let mut request = build_test_request("https://exact.example.com/path");
    let traces =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request, false)
            .unwrap();
    assert!(
        traces.len() >= 1,
        "contains and exact rules should still match"
    );
}

#[test]
fn rewrite_rule_respects_match_type_wildcard() {
    let manager = Arc::new(RewriteManager::new());
    manager.save_rule(RewriteRule {
        id: "wildcard-rule".to_string(),
        enabled: true,
        name: "Wildcard match".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec![],
            stage: "request".to_string(),
            url_pattern: "https://api.example.com/v1/*".to_string(),
            match_type: Some("wildcard".to_string()),
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({"headerName":"x-test","operation":"set","target":"request","value":"1"}),
    });

    let mut request = build_test_request("https://api.example.com/v1/users");
    let traces =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request, false)
            .unwrap();
    assert_eq!(traces.len(), 1);

    // different path prefix should NOT match wildcard anchored at start
    let mut request2 = build_test_request("https://api.example.com/v2/users");
    let traces2 =
        apply_request_rewrite_rules(&Some(manager.clone()), "default", &mut request2, false)
            .unwrap();
    assert!(traces2.is_empty());
}

#[test]
fn rewrite_rule_uses_contains_by_default() {
    let manager = Arc::new(RewriteManager::new());
    manager.save_rule(RewriteRule {
        id: "default-rule".to_string(),
        enabled: true,
        name: "Default match".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec![],
            stage: "request".to_string(),
            url_pattern: "api.example.com".to_string(),
            match_type: None,
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({"headerName":"x-test","operation":"set","target":"request","value":"1"}),
    });

    // substring match should work (legacy behavior)
    let mut request = build_test_request("https://api.example.com/v1/users");
    let traces =
        apply_request_rewrite_rules(&Some(manager), "default", &mut request, false).unwrap();
    assert_eq!(traces.len(), 1);
}

#[test]
fn applies_map_local_rules_by_reading_a_local_file() {
    let file_path =
        std::env::temp_dir().join(format!("aiproxy-map-local-{}.txt", std::process::id()));
    fs::write(&file_path, "mapped body").unwrap();

    let manager = MapManager::new();
    manager.save_rule(MapRule {
        id: "map-local".to_string(),
        enabled: true,
        mode: "local".to_string(),
        name: "Map local".to_string(),
        note: None,
        preserve_path: true,
        preserve_query: true,
        priority: 100,
        source_pattern: "example.com".to_string(),
        target_value: file_path.display().to_string(),
        workspace_id: "default".to_string(),
    });

    let mut request = build_test_request("http://example.com/asset.txt");
    let (response, traces) =
        apply_map_rules(&Some(Arc::new(manager)), "default", &mut request).unwrap();
    let response = response.unwrap();

    assert_eq!(response.status_code, StatusCode::OK);
    assert_eq!(
        String::from_utf8(response.response_body.clone()).unwrap(),
        "mapped body"
    );
    assert_eq!(traces.len(), 1);
    assert_eq!(traces[0].mode, "local");

    let _ = fs::remove_file(file_path);
}

#[test]
fn applies_map_local_rules_by_resolving_a_directory_path() {
    let dir_path =
        std::env::temp_dir().join(format!("aiproxy-map-local-dir-{}", std::process::id()));
    let asset_dir = dir_path.join("assets");
    fs::create_dir_all(&asset_dir).unwrap();
    fs::write(asset_dir.join("app.json"), r#"{"mapped":true}"#).unwrap();

    let manager = MapManager::new();
    manager.save_rule(MapRule {
        id: "map-local-dir".to_string(),
        enabled: true,
        mode: "local".to_string(),
        name: "Map local dir".to_string(),
        note: None,
        preserve_path: true,
        preserve_query: true,
        priority: 100,
        source_pattern: "example.com".to_string(),
        target_value: dir_path.display().to_string(),
        workspace_id: "default".to_string(),
    });

    let mut request = build_test_request("http://example.com/assets/app.json?cache=1");
    let (response, traces) =
        apply_map_rules(&Some(Arc::new(manager)), "default", &mut request).unwrap();
    let response = response.unwrap();

    assert_eq!(response.status_code, StatusCode::OK);
    assert_eq!(
        String::from_utf8(response.response_body.clone()).unwrap(),
        r#"{"mapped":true}"#
    );
    assert_eq!(traces.len(), 1);
    let expected_suffix = std::path::Path::new("assets").join("app.json");
    assert!(
        std::path::Path::new(traces[0].local_path.as_deref().unwrap_or_default())
            .ends_with(&expected_suffix)
    );

    let _ = fs::remove_dir_all(dir_path);
}

#[test]
fn applies_map_remote_rules_by_rewriting_the_request_url() {
    let manager = MapManager::new();
    manager.save_rule(MapRule {
        id: "map-remote".to_string(),
        enabled: true,
        mode: "remote".to_string(),
        name: "Map remote".to_string(),
        note: None,
        preserve_path: true,
        preserve_query: true,
        priority: 100,
        source_pattern: "api.example.com".to_string(),
        target_value: "https://staging.example.com/base?target=1".to_string(),
        workspace_id: "default".to_string(),
    });

    let mut request = build_test_request("http://api.example.com/v1/users?debug=true");
    let (response, traces) =
        apply_map_rules(&Some(Arc::new(manager)), "default", &mut request).unwrap();

    assert!(response.is_none());
    assert_eq!(
        request.url.as_str(),
        "https://staging.example.com/v1/users?debug=true"
    );
    assert_eq!(request.protocol, "https");
    assert_eq!(request.host, "staging.example.com");
    assert_eq!(traces.len(), 1);
    assert_eq!(
        traces[0].mapped_url.as_deref(),
        Some("https://staging.example.com/v1/users?debug=true")
    );
}

#[test]
fn picks_the_active_throttle_profile_for_the_workspace() {
    let manager = ThrottleManager::new();
    manager.save_profile(ThrottleProfileData {
        id: "profile-a".to_string(),
        download_kbps: 1024,
        enabled: false,
        latency_ms: 40,
        name: "Inactive".to_string(),
        note: None,
        packet_loss_ratio: 1.5,
        preset: false,
        upload_kbps: 512,
        workspace_id: "default".to_string(),
    });
    manager.save_profile(ThrottleProfileData {
        id: "profile-b".to_string(),
        download_kbps: 2048,
        enabled: true,
        latency_ms: 120,
        name: "Active".to_string(),
        note: None,
        packet_loss_ratio: 0.2,
        preset: false,
        upload_kbps: 1024,
        workspace_id: "default".to_string(),
    });

    let profile =
        active_throttle_profile_for_workspace(&Some(Arc::new(manager)), "default").unwrap();

    assert_eq!(profile.id, "profile-b");
    assert_eq!(profile.latency_ms, 120);
}

#[tokio::test]
async fn forwards_plain_http_requests_and_emits_a_session_detail() {
    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0_u8; 1024];
        let _ = stream.read(&mut buffer).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHello")
            .await
            .unwrap();
    });

    let proxy_port = allocate_unused_port();
    let mut started_proxy: StartedProxyServer = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
                http2_enabled: None,
            },
            workspace_id: None,
            event_emitter: None,
        },
        ProxyManagers {
            tls: None,
            breakpoint: None,
            rewrite: None,
            map: None,
            script: None,
            throttle: None,
            dns: None,
        },
    )
    .await
    .unwrap();

    let target_url = format!("http://127.0.0.1:{upstream_port}/hello");
    let mut client_stream = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    let request = format!(
        "GET {target_url} HTTP/1.1\r\nHost: 127.0.0.1:{upstream_port}\r\nConnection: close\r\n\r\n"
    );
    client_stream.write_all(request.as_bytes()).await.unwrap();

    let mut response = String::new();
    client_stream.read_to_string(&mut response).await.unwrap();
    let session: ProxySessionDetail = timeout(Duration::from_secs(1), async {
        loop {
            let session = started_proxy.session_receiver.recv().await.unwrap();
            if session.summary.status_code != 0 {
                break session;
            }
        }
    })
    .await
    .expect("timed out waiting for the completed session detail");

    assert!(response.contains("HTTP/1.1 200 OK"));
    assert!(response.contains("Hello"));
    assert_eq!(session.summary.method, "GET");
    assert_eq!(session.summary.host, "127.0.0.1");
    assert_eq!(session.summary.path, "/hello");
    assert_eq!(session.summary.status_code, 200);
    assert_eq!(
        session.request_headers[0].name.to_ascii_lowercase(),
        "host".to_string()
    );
    assert_eq!(
        session
            .response_body
            .as_ref()
            .and_then(|body| body.inline_text()),
        Some("Hello".to_string())
    );

    started_proxy.server_handle.shutdown().await;
    upstream_task.await.unwrap();
}

#[tokio::test]
async fn plain_http_upstream_timeout_emits_a_completed_gateway_timeout_session() {
    let _timeout_guard = override_upstream_request_timeout_for_test(Duration::from_millis(100));
    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0_u8; 1024];
        let _ = stream.read(&mut buffer).await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
    });

    let proxy_port = allocate_unused_port();
    let mut started_proxy: StartedProxyServer = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
                http2_enabled: None,
            },
            workspace_id: None,
            event_emitter: None,
        },
        ProxyManagers {
            tls: None,
            breakpoint: None,
            rewrite: None,
            map: None,
            script: None,
            throttle: None,
            dns: None,
        },
    )
    .await
    .unwrap();

    let target_url = format!("http://127.0.0.1:{upstream_port}/slow");
    let mut client_stream = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    let request = format!(
        "GET {target_url} HTTP/1.1\r\nHost: 127.0.0.1:{upstream_port}\r\nConnection: close\r\n\r\n"
    );
    client_stream.write_all(request.as_bytes()).await.unwrap();

    let mut response = String::new();
    client_stream.read_to_string(&mut response).await.unwrap();
    let session: ProxySessionDetail = timeout(Duration::from_secs(1), async {
        loop {
            let session = started_proxy.session_receiver.recv().await.unwrap();
            if session.summary.status_code != 0 {
                break session;
            }
        }
    })
    .await
    .expect("timed out waiting for the completed timeout session detail");

    assert!(response.contains("504 Gateway Timeout"));
    assert_eq!(session.summary.status_code, 504);
    assert_eq!(session.summary.method, "GET");
    assert_eq!(session.summary.path, "/slow");

    started_proxy.server_handle.shutdown().await;
    upstream_task.abort();
}

#[tokio::test]
async fn forwards_large_http_responses_without_truncating_the_client_body() {
    let large_body = vec![b'a'; MAX_CAPTURED_BODY_BYTES + 1024];
    let expected_len = large_body.len();

    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0_u8; 1024];
        let _ = stream.read(&mut buffer).await.unwrap();
        stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {expected_len}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        stream.write_all(&large_body).await.unwrap();
    });

    let proxy_port = allocate_unused_port();
    let mut started_proxy = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
                http2_enabled: None,
            },
            workspace_id: None,
            event_emitter: None,
        },
        ProxyManagers {
            tls: None,
            breakpoint: None,
            rewrite: None,
            map: None,
            script: None,
            throttle: None,
            dns: None,
        },
    )
    .await
    .unwrap();

    let target_url = format!("http://127.0.0.1:{upstream_port}/large");
    let mut client_stream = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    let request = format!(
        "GET {target_url} HTTP/1.1\r\nHost: 127.0.0.1:{upstream_port}\r\nConnection: close\r\n\r\n"
    );
    client_stream.write_all(request.as_bytes()).await.unwrap();

    let mut response_bytes = Vec::new();
    client_stream
        .read_to_end(&mut response_bytes)
        .await
        .unwrap();
    let session: ProxySessionDetail = timeout(Duration::from_secs(2), async {
        loop {
            let session = started_proxy.session_receiver.recv().await.unwrap();
            if session.summary.status_code != 0 {
                break session;
            }
        }
    })
    .await
    .expect("timed out waiting for the completed session detail");

    let header_end = find_header_end(&response_bytes).expect("missing HTTP response headers");
    let body = &response_bytes[header_end..];

    assert_eq!(body.len(), expected_len);
    assert!(body.iter().all(|byte| *byte == b'a'));
    assert_eq!(session.summary.size_bytes, expected_len);
    assert_eq!(
        session.response_body.as_ref().map(|body| body.size_bytes),
        Some(expected_len)
    );
    assert_eq!(
        session
            .response_body
            .as_ref()
            .and_then(|body| body.truncated.then_some(true)),
        Some(true)
    );

    started_proxy.server_handle.shutdown().await;
    upstream_task.await.unwrap();
}

#[tokio::test]
async fn direct_request_marks_large_response_previews_as_truncated() {
    let large_body = vec![b'b'; MAX_CAPTURED_BODY_BYTES + 2048];
    let expected_len = large_body.len();

    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0_u8; 1024];
        let _ = stream.read(&mut buffer).await.unwrap();
        stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {expected_len}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        stream.write_all(&large_body).await.unwrap();
    });

    let detail = send_direct_request(
        "GET".to_string(),
        format!("http://127.0.0.1:{upstream_port}/compose"),
        Vec::new(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(detail.summary.status_code, 200);
    assert_eq!(detail.summary.size_bytes, expected_len);
    assert_eq!(
        detail.response_body.as_ref().map(|body| body.size_bytes),
        Some(expected_len)
    );
    assert_eq!(
        detail
            .response_body
            .as_ref()
            .and_then(|body| body.truncated.then_some(true)),
        Some(true)
    );

    upstream_task.await.unwrap();
}

fn build_test_session_detail() -> ProxySessionDetail {
    ProxySessionDetail {
        client_address: Some("127.0.0.1:54321".to_string()),
        cookies: Vec::new(),
        id: "session-1".to_string(),
        query_params: Vec::new(),
        raw_request_head: Some(build_raw_http_head(
            "GET /hello HTTP/1.1",
            &[ProxyHeaderEntry {
                name: "Host".to_string(),
                value: "example.com".to_string(),
                is_pseudo: None,
            }],
        )),
        raw_response_head: Some(build_raw_http_head(
            "HTTP/1.1 200 OK",
            &[ProxyHeaderEntry {
                name: "Content-Type".to_string(),
                value: "text/plain".to_string(),
                is_pseudo: None,
            }],
        )),
        request_body: None,
        request_headers: vec![ProxyHeaderEntry {
            name: "Host".to_string(),
            value: "example.com".to_string(),
            is_pseudo: None,
        }],
        response_body: None,
        response_headers: vec![ProxyHeaderEntry {
            name: "Content-Type".to_string(),
            value: "text/plain".to_string(),
            is_pseudo: None,
        }],
        map_traces: Vec::new(),
        rewrite_traces: Vec::new(),
        server_ip: None,
        summary: ProxySessionSummary {
            id: "session-1".to_string(),
            method: "GET".to_string(),
            host: "example.com".to_string(),
            path: "/hello".to_string(),
            protocol: "http".to_string(),
            scheme: "http".to_string(),
            http_version: "1.1".to_string(),
            transport_protocol: "tcp".to_string(),
            application_protocol: "http".to_string(),
            started_at: "2026-04-21T00:00:00Z".to_string(),
            finished_at: "2026-04-21T00:00:01Z".to_string(),
            duration_ms: 1,
            size_bytes: 0,
            status_code: 200,
            url: "http://example.com/hello".to_string(),
            response_mime_type: None,
        },
        script_traces: Vec::new(),
        throttle_traces: Vec::new(),
        tls_cipher_suite: None,
        tls_protocol: None,
        timing: None,
        timing_source: None,
        trailers: None,
        h2_stream_id: None,
    }
}

#[test]
fn test_proxy_header_entry_is_pseudo_serialization() {
    let entry = ProxyHeaderEntry {
        name: ":method".to_string(),
        value: "GET".to_string(),
        is_pseudo: Some(true),
    };
    let json = serde_json::to_string(&entry).unwrap();
    assert!(json.contains("\"isPseudo\":true"));
    assert!(json.contains("\"name\":\":method\""));

    // Regular header without is_pseudo
    let regular = ProxyHeaderEntry {
        name: "content-type".to_string(),
        value: "text/html".to_string(),
        is_pseudo: None,
    };
    let json2 = serde_json::to_string(&regular).unwrap();
    assert!(!json2.contains("is_pseudo"));
}

#[test]
fn test_proxy_session_detail_h2_fields_serialization() {
    let mut detail = build_test_session_detail();
    detail.trailers = Some(vec![ProxyHeaderEntry {
        name: "grpc-status".to_string(),
        value: "0".to_string(),
        is_pseudo: None,
    }]);
    detail.h2_stream_id = Some(42);

    let json = serde_json::to_string(&detail).unwrap();
    assert!(json.contains("\"trailers\""));
    assert!(json.contains("\"grpc-status\""));
    assert!(json.contains("\"h2StreamId\":42"));
}

#[test]
fn test_proxy_header_entry_roundtrip() {
    let entry = ProxyHeaderEntry {
        name: ":authority".to_string(),
        value: "example.com".to_string(),
        is_pseudo: Some(true),
    };
    let json = serde_json::to_string(&entry).unwrap();
    let deserialized: ProxyHeaderEntry = serde_json::from_str(&json).unwrap();
    assert_eq!(entry.name, deserialized.name);
    assert_eq!(entry.value, deserialized.value);
    assert_eq!(entry.is_pseudo, deserialized.is_pseudo);
}

// ---------------------------------------------------------------------------
// WebSocket regression tests — lock in the WS error/session fixes
// ---------------------------------------------------------------------------

/// Helper: send a raw WS upgrade request through the proxy and return
/// (response_text, completed_session).
async fn send_ws_upgrade_via_proxy(
    proxy_port: u16,
    upstream_port: u16,
    started_proxy: &mut StartedProxyServer,
) -> (String, ProxySessionDetail) {
    let target_url = format!("ws://127.0.0.1:{upstream_port}/chat");
    let mut client_stream = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    let request = format!(
        "GET {target_url} HTTP/1.1\r\n\
         Host: 127.0.0.1:{upstream_port}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\
         \r\n"
    );
    client_stream.write_all(request.as_bytes()).await.unwrap();

    // Read the proxy response.
    let mut response_buf = [0u8; 4096];
    let n = timeout(
        Duration::from_secs(3),
        client_stream.read(&mut response_buf),
    )
    .await
    .expect("timed out reading proxy response")
    .unwrap();
    let response_text = String::from_utf8_lossy(&response_buf[..n]).to_string();

    // Collect the first completed session (skip pending status=0).
    let completed_session = timeout(Duration::from_secs(2), async {
        loop {
            let session = started_proxy.session_receiver.recv().await.unwrap();
            if session.summary.status_code != 0 {
                break session;
            }
        }
    })
    .await
    .expect("timed out waiting for completed session");

    (response_text, completed_session)
}

/// After collecting the primary completed session, drain the channel briefly
/// and assert that no additional completed sessions (status != 0) appear.
async fn assert_no_duplicate_completed_sessions(
    started_proxy: &mut StartedProxyServer,
    context: &str,
) {
    let mut extra_completed = Vec::new();
    let drain_deadline = tokio::time::Instant::now() + Duration::from_millis(200);
    loop {
        let remaining = drain_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match timeout(remaining, started_proxy.session_receiver.recv()).await {
            Ok(Some(s)) if s.summary.status_code != 0 => extra_completed.push(s),
            _ => break,
        }
    }
    assert!(
        extra_completed.is_empty(),
        "{context}: expected no duplicate completed sessions, got statuses: {:?}",
        extra_completed
            .iter()
            .map(|s| s.summary.status_code)
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn ws_upgrade_upstream_connect_failure_emits_502_not_499() {
    // Use a port that is not listening (allocate_unused_port opens and
    // immediately closes, so the port is free but nobody is accepting).
    let dead_port = allocate_unused_port();

    let proxy_port = allocate_unused_port();
    let mut started_proxy = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
                http2_enabled: None,
            },
            workspace_id: None,
            event_emitter: None,
        },
        ProxyManagers {
            tls: None,
            breakpoint: None,
            rewrite: None,
            map: None,
            script: None,
            throttle: None,
            dns: None,
        },
    )
    .await
    .unwrap();

    let (response_text, completed_session) =
        send_ws_upgrade_via_proxy(proxy_port, dead_port, &mut started_proxy).await;

    // The proxy response should be 502 Bad Gateway.
    assert!(
        response_text.contains("502"),
        "expected 502 response, got: {response_text}"
    );

    // The completed session must be 502 — NOT 499 (client cancelled).
    assert_eq!(
        completed_session.summary.status_code, 502,
        "expected 502 session, got {}",
        completed_session.summary.status_code
    );

    // No duplicate completed sessions (e.g. no 499 from guard).
    assert_no_duplicate_completed_sessions(&mut started_proxy, "ws_connect_failure").await;

    started_proxy.server_handle.shutdown().await;
}

#[tokio::test]
async fn ws_upgrade_non_101_response_no_registry_no_duplicate_session() {
    // Mock upstream that returns 403 Forbidden (refuses upgrade).
    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0u8; 2048];
        let _ = stream.read(&mut buffer).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nForbidden")
            .await
            .unwrap();
    });

    let proxy_port = allocate_unused_port();
    let mut started_proxy = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
                http2_enabled: None,
            },
            workspace_id: None,
            event_emitter: None,
        },
        ProxyManagers {
            tls: None,
            breakpoint: None,
            rewrite: None,
            map: None,
            script: None,
            throttle: None,
            dns: None,
        },
    )
    .await
    .unwrap();

    let (response_text, completed_session) =
        send_ws_upgrade_via_proxy(proxy_port, upstream_port, &mut started_proxy).await;

    // The proxy response should forward the upstream's 403.
    assert!(
        response_text.contains("403"),
        "expected 403 response, got: {response_text}"
    );

    // Status should be 403, NOT 499 or 502.
    assert_eq!(completed_session.summary.status_code, 403);

    // WS registry must NOT have this session (only 101 gets registered).
    let registry = crate::ws::global_ws_registry();
    assert_eq!(
        registry.get_status(&completed_session.id),
        crate::ws::WsConnectionStatus::Closed,
        "non-101 session should not be in WS registry"
    );

    // No duplicate completed sessions.
    assert_no_duplicate_completed_sessions(&mut started_proxy, "ws_non_101").await;

    started_proxy.server_handle.shutdown().await;
    upstream_task.await.unwrap();
}

#[tokio::test]
async fn ws_upgrade_101_success_carries_rewrite_traces() {
    // Mock upstream that returns 101 Switching Protocols.
    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0u8; 2048];
        let _ = stream.read(&mut buffer).await.unwrap();
        stream
            .write_all(
                b"HTTP/1.1 101 Switching Protocols\r\n\
                  Upgrade: websocket\r\n\
                  Connection: Upgrade\r\n\
                  Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\
                  \r\n",
            )
            .await
            .unwrap();
        // Keep the connection alive briefly for the relay to start.
        tokio::time::sleep(Duration::from_millis(500)).await;
    });

    // Set up a request-stage rewrite rule that matches the WS URL.
    let rewrite_manager = Arc::new(RewriteManager::new());
    rewrite_manager.save_rule(RewriteRule {
        id: "ws-test-rewrite".to_string(),
        enabled: true,
        name: "WS test rewrite".to_string(),
        note: None,
        priority: 10,
        r#match: RewriteRuleMatch {
            methods: vec!["GET".to_string()],
            stage: "request".to_string(),
            url_pattern: "127.0.0.1".to_string(),
            match_type: None,
        },
        rewrite_type: "header".to_string(),
        workspace_id: "default".to_string(),
        payload: json!({
            "headerName": "x-ws-test",
            "operation": "set",
            "target": "request",
            "value": "true"
        }),
    });

    let proxy_port = allocate_unused_port();
    let mut started_proxy = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
                http2_enabled: None,
            },
            workspace_id: Some("default".to_string()),
            event_emitter: None,
        },
        ProxyManagers {
            tls: None,
            breakpoint: None,
            rewrite: Some(rewrite_manager),
            map: None,
            script: None,
            throttle: None,
            dns: None,
        },
    )
    .await
    .unwrap();

    let (response_text, completed_session) =
        send_ws_upgrade_via_proxy(proxy_port, upstream_port, &mut started_proxy).await;

    // The proxy response should be 101 Switching Protocols.
    assert!(
        response_text.starts_with("HTTP/1.1 101"),
        "expected 101 response, got: {response_text}"
    );

    // Session status should be 101.
    assert_eq!(completed_session.summary.status_code, 101);

    // The session should carry the rewrite trace from the request-stage rule.
    assert!(
        !completed_session.rewrite_traces.is_empty(),
        "expected rewrite_traces to be populated on 101 session, but got {:?}",
        completed_session.rewrite_traces
    );

    started_proxy.server_handle.shutdown().await;
    upstream_task.await.unwrap();
}

fn allocate_unused_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn header_entry<'a>(headers: &'a [ProxyHeaderEntry], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|entry| entry.name.eq_ignore_ascii_case(name))
        .map(|entry| entry.value.as_str())
}

fn build_test_request(url: &str) -> ParsedProxyRequest {
    let parsed_url = Url::parse(url).unwrap();
    let request_headers = vec![ProxyHeaderEntry {
        name: "Host".to_string(),
        value: match parsed_url.port() {
            Some(port) => format!("{}:{port}", parsed_url.host_str().unwrap_or_default()),
            None => parsed_url.host_str().unwrap_or_default().to_string(),
        },
        is_pseudo: None,
    }];

    ParsedProxyRequest {
        body: Vec::new(),
        client_address: Some("127.0.0.1:54321".to_string()),
        headers: build_upstream_headers_from_entries(&request_headers)
            .unwrap_or_else(|_| HeaderMap::new()),
        host: parsed_url.host_str().unwrap().to_string(),
        method: Method::GET,
        path: super::build_request_path(&parsed_url),
        protocol: parsed_url.scheme().to_string(),
        query_params: super::build_query_params(&parsed_url),
        raw_request: format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\n\r\n",
            super::build_request_path(&parsed_url),
            request_headers[0].value
        ),
        request_headers,
        request_id: "test-request".to_string(),
        url: parsed_url,
        tls_cipher_suite: None,
        tls_protocol: None,
    }
}
