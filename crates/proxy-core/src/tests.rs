use super::rules::{
    active_throttle_profile_for_workspace, apply_map_rules, apply_request_rewrite_rules,
    apply_response_rewrite_rules,
};
use super::{
    apply_request_resolution, apply_response_resolution, build_raw_http_head, build_request_path,
    build_upstream_headers_from_entries, find_header_end, infer_protocol_metadata,
    override_tunnel_idle_timeout_for_test, override_upstream_request_timeout_for_test,
    override_ws_upstream_body_read_idle_timeout_for_test, resolve_target_url, send_direct_request,
    start_proxy_server, BreakpointActionKind, BreakpointResolution, MapManager, MapRule,
    ParsedProxyRequest, ProxyBodyReference, ProxyConfig, ProxyHeaderEntry, ProxyManagers,
    ProxyRuntimeConfig, ProxySessionDetail, ProxySessionSummary, ProxyTimingBreakdown,
    RewriteManager, RewriteRule, RewriteRuleMatch, StartedProxyServer, ThrottleManager,
    ThrottleProfileData, UpstreamResponse, MAX_CAPTURED_BODY_BYTES,
};
use http::header::{HeaderMap, HeaderValue};
use http::{Method, StatusCode};
use proptest::prelude::*;
use serde_json::json;
use std::{fs, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{sleep, timeout},
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

/// Regression test for H5: when an h1 upstream request times out, the per-
/// request h1 conn-driver task must be aborted (it must not linger as an
/// orphaned task holding the socket until the peer FINs). Under
/// high-frequency timeouts each leaked driver costs a task + file descriptor,
/// so we assert the active-driver count returns to zero after a timeout.
///
/// We observe task lifetime directly via `h1_active_conn_drivers_for_test()`
/// (the leak is invisible from the upstream side because dropping the h1
/// `SendRequest` already sends a write-side FIN; what lingers is the spawned
/// driver task itself). Before the fix the spawned driver was detached and the
/// count stayed at 1 indefinitely; after the fix the abort-on-drop guard
/// decrements it back to 0.
#[tokio::test]
async fn h1_conn_driver_is_aborted_after_request_timeout() {
    use crate::upstream::h1_active_conn_drivers_for_test;

    let baseline = h1_active_conn_drivers_for_test();
    let _timeout_guard = override_upstream_request_timeout_for_test(Duration::from_millis(100));

    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();

    // Upstream: accept the proxied connection, read the request line, then hang
    // without responding. Signal once the request line is read so the test can
    // be sure the proxy has an established upstream connection before relying
    // on the timeout firing.
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _peer) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0_u8; 1024];
        let _ = stream.read(&mut buffer).await.unwrap();
        let _ = accepted_tx.send(());
        // Hold the connection open; the proxy timeout drops forward_request.
        // The driver is aborted, which drops the proxy-side socket, so the
        // upstream observes EOF here (secondary behavioral check).
        let mut sink = [0_u8; 64];
        let _ = stream.read(&mut sink).await;
    });

    let proxy_port = allocate_unused_port();
    let started_proxy: StartedProxyServer = start_proxy_server(
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

    // Wait for the proxy to have an established upstream connection.
    accepted_rx.await.unwrap();

    // Drain the 504 response so the proxy finishes its timeout-handling path
    // (the future drop that triggers the guard happens on timeout elapse).
    let mut response = String::new();
    let _ = client_stream.read_to_string(&mut response).await.unwrap();
    assert!(
        response.contains("504 Gateway Timeout"),
        "expected a 504 response, got: {response}"
    );

    // The driver task must be gone by now. Give the runtime a short moment to
    // run the drop bookkeeping, then assert the active-driver count is back to
    // baseline. This guards against any future change (e.g. a hyper upgrade)
    // that stops the conn future from completing on SendRequest drop — in that
    // case a detached driver would linger and this assertion would go RED.
    let settled = timeout(Duration::from_secs(2), async {
        loop {
            if h1_active_conn_drivers_for_test() == baseline {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(
        settled.is_ok(),
        "h1 conn driver lingered after a timed-out request: active driver count = {} \
         (baseline {}), expected {}. Orphaned driver task leak (H5 regression).",
        h1_active_conn_drivers_for_test(),
        baseline,
        baseline,
    );

    // Confirm the abort-on-drop path actually fired (proves the guard is wired
    // in and providing its defense-in-depth guarantee).
    let (_natural, aborts) = crate::upstream::h1_conn_driver_completion_breakdown_for_test();
    assert!(
        aborts >= 1,
        "expected the h1 conn driver abort path to fire on timeout, but aborts={aborts}"
    );

    upstream_task.abort();
    started_proxy.server_handle.shutdown().await;
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
async fn ws_upgrade_non_101_forwards_full_body_beyond_leftover() {
    // Upstream returns 403 with a body LARGER than the head-read leftover
    // buffer (READ_BUFFER_BYTES = 8 KiB). The proxy must forward the FULL
    // body to the client, not just the leftover bytes captured while reading
    // the response head.
    let body_size: usize = 12 * 1024; // 12 KiB > 8 KiB leftover cap
    let body_bytes: Vec<u8> = (0..body_size).map(|i| (i % 251) as u8).collect();

    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let body_for_upstream = body_bytes.clone();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0u8; 2048];
        let _ = stream.read(&mut buffer).await.unwrap();
        // Write head and body in separate write_all calls so the head-reader's
        // first 8 KiB read cannot capture the entire body — mirroring a real
        // upstream that streams the body after the head.
        let head = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: {}\r\n\r\n",
            body_size
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(&body_for_upstream).await.unwrap();
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

    // Send the WS upgrade request directly (the shared helper only reads a
    // 4 KiB response buffer, but this test asserts a > 8 KiB body is fully
    // forwarded, so we read the full response ourselves).
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

    // Read the full proxy response (head + body) in a loop until we have at
    // least the declared body, then drain any trailing bytes.
    let mut response_buf: Vec<u8> = Vec::with_capacity(body_size + 256);
    let mut chunk = [0u8; 4096];
    loop {
        let n = match timeout(Duration::from_secs(3), client_stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => n,
            Ok(Err(e)) => panic!("client read error: {e}"),
            Err(_) => break, // timeout — upstream done sending
        };
        response_buf.extend_from_slice(&chunk[..n]);
        // Once the head + full body is captured we can stop; the proxy closes
        // the connection after a non-101 response.
        if let Some(body_start) = find_header_end(&response_buf) {
            if response_buf.len() >= body_start + body_size {
                break;
            }
        }
    }
    // The body is binary, so operate on the raw bytes — NOT a UTF-8 lossy
    // string (which would mangle non-UTF-8 bytes and corrupt the comparison).
    let response_bytes = &response_buf[..];

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

    // The proxy response should forward the upstream's 403 status.
    let head_end =
        find_header_end(response_bytes).expect("response must contain a complete HTTP head");
    let response_head = std::str::from_utf8(&response_bytes[..head_end]).unwrap();
    assert!(
        response_head.contains("403"),
        "expected 403 response, got: {response_head}"
    );

    // Status should be 403, NOT 499 or 502.
    assert_eq!(completed_session.summary.status_code, 403);

    // The client must receive the FULL body — not just the leftover bytes
    // captured while reading the response head. Extract the body region and
    // compare it byte-for-byte against the expected body.
    let received_body = &response_bytes[head_end..];
    assert_eq!(
        received_body.len(),
        body_size,
        "expected full {} byte body, got {} bytes (body truncated to leftover)",
        body_size,
        received_body.len()
    );
    assert_eq!(
        received_body,
        &body_bytes[..],
        "body content mismatch — full body must be forwarded, not just leftover"
    );

    // WS registry must NOT have this session (only 101 gets registered).
    let registry = crate::ws::global_ws_registry();
    assert_eq!(
        registry.get_status(&completed_session.id),
        crate::ws::WsConnectionStatus::Closed,
        "non-101 session should not be in WS registry"
    );

    // No duplicate completed sessions.
    assert_no_duplicate_completed_sessions(&mut started_proxy, "ws_non_101_full_body").await;

    started_proxy.server_handle.shutdown().await;
    upstream_task.await.unwrap();
}

#[tokio::test]
async fn ws_upgrade_non_101_no_content_length_does_not_hang() {
    // Regression: a non-101 refusal on an HTTP/1.1 keep-alive connection with
    // NO Content-Length must not block forever. The old read-until-EOF loop
    // waited for EOF that a keep-alive peer never sends, so the client never
    // received the refusal and the session was never emitted. The proxy now
    // bounds each body read with an idle timeout and returns the refusal body.
    // Shrink the idle ceiling so a regression fails fast instead of waiting
    // the full default 10s.
    let _guard = override_ws_upstream_body_read_idle_timeout_for_test(Duration::from_millis(300));

    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0u8; 2048];
        let _ = stream.read(&mut buffer).await.unwrap();
        // No Content-Length, no Connection: close. Crucially, keep the socket
        // OPEN (keep-alive) so the proxy never sees EOF — this is exactly what
        // hung the old loop.
        stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nForbidden")
            .await
            .unwrap();
        // Hold the connection open past the test window.
        tokio::time::sleep(Duration::from_secs(30)).await;
        drop(stream);
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

    // Outer guard: a hung proxy must fail the test instead of hanging CI.
    let response_buf = timeout(Duration::from_secs(10), async {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match timeout(Duration::from_secs(2), client_stream.read(&mut chunk)).await {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
                Ok(Err(e)) => panic!("client read error: {e}"),
                Err(_) => break, // idle — proxy done sending
            }
        }
        buf
    })
    .await
    .expect("proxy hung: client never received the non-101 refusal in time");

    let head_end =
        find_header_end(&response_buf).expect("response must contain a complete HTTP head");
    let response_head = std::str::from_utf8(&response_buf[..head_end]).unwrap();
    assert!(
        response_head.contains("403"),
        "expected 403 response, got: {response_head}"
    );
    // The refusal body must be forwarded even though EOF never arrived.
    assert_eq!(
        &response_buf[head_end..],
        b"Forbidden",
        "expected 'Forbidden' body forwarded without EOF"
    );

    // The session must complete (a hung proxy would leave it pending forever).
    let completed_session = timeout(Duration::from_secs(3), async {
        loop {
            let session = started_proxy.session_receiver.recv().await.unwrap();
            if session.summary.status_code != 0 {
                break session;
            }
        }
    })
    .await
    .expect("timed out waiting for completed session");
    assert_eq!(completed_session.summary.status_code, 403);

    assert_no_duplicate_completed_sessions(&mut started_proxy, "ws_no_cl").await;

    started_proxy.server_handle.shutdown().await;
    // Don't wait for the 30s keep-alive hold to finish.
    upstream_task.abort();
}

#[tokio::test]
async fn ws_upgrade_non_101_chunked_body_decoded() {
    // Regression: a non-101 refusal using Transfer-Encoding: chunked must be
    // DECODED before forwarding — the client should receive the plain body,
    // not the raw chunk framing ("e\r\n" size prefix, "0\r\n\r\n" terminator).
    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let expected_body = "Forbidden page"; // 14 bytes = 0xe
    let expected_body_len = expected_body.len();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        let mut buffer = [0u8; 2048];
        let _ = stream.read(&mut buffer).await.unwrap();
        let resp = format!(
            "HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\n\r\n\
             e\r\n{expected_body}\r\n\
             0\r\n\r\n"
        );
        stream.write_all(resp.as_bytes()).await.unwrap();
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

    let response_buf = timeout(Duration::from_secs(10), async {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match timeout(Duration::from_secs(2), client_stream.read(&mut chunk)).await {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
                Ok(Err(e)) => panic!("client read error: {e}"),
                Err(_) => break, // idle — proxy done sending
            }
            if let Some(body_start) = find_header_end(&buf) {
                if buf.len() >= body_start + expected_body_len {
                    break;
                }
            }
        }
        buf
    })
    .await
    .expect("proxy did not forward the chunked refusal in time");

    let head_end =
        find_header_end(&response_buf).expect("response must contain a complete HTTP head");
    let response_head = std::str::from_utf8(&response_buf[..head_end]).unwrap();
    assert!(
        response_head.contains("403"),
        "expected 403 response, got: {response_head}"
    );
    // The proxy rewrites framing to Content-Length (strips Transfer-Encoding).
    assert!(
        response_head
            .to_ascii_lowercase()
            .contains("content-length"),
        "expected Content-Length in proxied head, got: {response_head}"
    );
    assert_eq!(
        &response_buf[head_end..],
        expected_body.as_bytes(),
        "chunked body must be DECODED — raw chunk framing leaked: {:?}",
        String::from_utf8_lossy(&response_buf[head_end..])
    );

    let completed_session = timeout(Duration::from_secs(3), async {
        loop {
            let session = started_proxy.session_receiver.recv().await.unwrap();
            if session.summary.status_code != 0 {
                break session;
            }
        }
    })
    .await
    .expect("timed out waiting for completed session");
    assert_eq!(completed_session.summary.status_code, 403);

    assert_no_duplicate_completed_sessions(&mut started_proxy, "ws_chunked").await;

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

// ---------------------------------------------------------------------------
// Property-based tests for infer_protocol_metadata
// ---------------------------------------------------------------------------

// P2-1: scheme is always "http" or "https"
proptest! {
    #[test]
    fn scheme_is_always_http_or_https(protocol in ".*", url in "http[s]?://.*") {
        let meta = infer_protocol_metadata(&protocol, &url);
        prop_assert!(meta.scheme == "http" || meta.scheme == "https");
    }
}

// P2-2: ws → http, wss → https
proptest! {
    #[test]
    fn ws_maps_to_http(url in "ws://[a-zA-Z0-9].*") {
        let meta = infer_protocol_metadata("ws", &url);
        prop_assert_eq!(meta.scheme, "http");
    }

    #[test]
    fn wss_maps_to_https(url in "wss://[a-zA-Z0-9].*") {
        let meta = infer_protocol_metadata("wss", &url);
        prop_assert_eq!(meta.scheme, "https");
    }
}

// P2-3: h2 → TCP, h3 → QUIC
proptest! {
    #[test]
    fn h2_transport_is_tcp(url in "https://[a-zA-Z0-9].*") {
        let meta = infer_protocol_metadata("h2", &url);
        prop_assert_eq!(meta.transport_protocol, "tcp");
    }

    #[test]
    fn h3_transport_is_quic(url in "https://[a-zA-Z0-9].*") {
        let meta = infer_protocol_metadata("h3", &url);
        prop_assert_eq!(meta.transport_protocol, "quic");
    }
}

// P2-4: ws/wss → application_protocol = "websocket"
proptest! {
    #[test]
    fn ws_application_protocol_is_websocket(url in "ws://[a-zA-Z0-9].*") {
        let meta = infer_protocol_metadata("ws", &url);
        prop_assert_eq!(meta.application_protocol, "websocket");
    }

    #[test]
    fn wss_application_protocol_is_websocket(url in "wss://[a-zA-Z0-9].*") {
        let meta = infer_protocol_metadata("wss", &url);
        prop_assert_eq!(meta.application_protocol, "websocket");
    }
}

// P2-5: Unknown protocol fallback — scheme from URL, http_version defaults "1.1"
proptest! {
    #[test]
    fn unknown_protocol_falls_back_to_url_scheme_and_default_http_version(
        protocol in "[a-zA-Z][a-zA-Z0-9]*",
        host in "[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]",
        path in "[a-zA-Z0-9/._-]*"
    ) {
        let url = format!("https://{host}/{path}");
        // Filter out known protocol names and digit-only/pattern patterns
        prop_assume!(!matches!(
            protocol.to_ascii_lowercase().as_str(),
            "http" | "https" | "ws" | "wss" | "h2" | "h3" | "http2" | "http3" | "grpc" | "grpc-web"
        ));
        prop_assume!(!protocol.starts_with("HTTP/"));
        prop_assume!(!protocol.chars().all(|c| c.is_ascii_digit() || c == '.'));

        // Some generated hosts (e.g. "08", "00") are rejected by the `url`
        // crate as invalid IPv4 hosts. infer_protocol_metadata falls back to
        // "http" when the URL fails to parse, which is expected behavior —
        // exclude those hosts so the assertion only covers parseable URLs.
        prop_assume!(Url::parse(&url).is_ok());

        let meta = infer_protocol_metadata(&protocol, &url);
        prop_assert_eq!(meta.scheme, "https");
        prop_assert_eq!(meta.http_version, "1.1");
    }
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

// ---------------------------------------------------------------------------
// CONNECT blind-tunnel regression tests (SSL interception OFF)
//
// When `tls_manager` is `None`, a CONNECT request is served by the blind TCP
// relay (`tunnel_blind_relay`) — no MITM, no decryption. These tests lock in
// M4: the proxy must connect the upstream FIRST and reply 502 on failure,
// rather than unconditionally sending a fake 200 before connecting.
// ---------------------------------------------------------------------------

/// Helper: send a raw CONNECT request through the proxy and return the first
/// HTTP response head line the client receives (e.g. "HTTP/1.1 502 Bad Gateway").
async fn send_connect_request_read_status_line(proxy_port: u16, target_port: u16) -> String {
    let mut client_stream = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    let request = format!(
        "CONNECT 127.0.0.1:{target_port} HTTP/1.1\r\n\
         Host: 127.0.0.1:{target_port}\r\n\
         \r\n"
    );
    client_stream.write_all(request.as_bytes()).await.unwrap();

    // Read the proxy's response head.
    let mut response_buf = [0u8; 4096];
    let n = timeout(
        Duration::from_secs(3),
        client_stream.read(&mut response_buf),
    )
    .await
    .expect("timed out reading proxy response to CONNECT")
    .unwrap();
    let text = String::from_utf8_lossy(&response_buf[..n]).to_string();
    text.lines().next().unwrap_or("").to_string()
}

#[tokio::test]
async fn blind_tunnel_returns_502_when_upstream_unreachable() {
    // A port nobody is listening on (allocate_unused_port opens then closes,
    // so the port is free but nobody accepts — connect will be refused).
    let dead_port = allocate_unused_port();

    let proxy_port = allocate_unused_port();
    let started_proxy = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
                http2_enabled: None,
            },
            workspace_id: None,
            event_emitter: None,
        },
        // tls: None -> CONNECT goes through the blind relay (no MITM).
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

    let status_line = send_connect_request_read_status_line(proxy_port, dead_port).await;

    // The proxy must connect the upstream FIRST and reply 502 Bad Gateway on
    // failure, NOT a fake 200 Connection Established.
    assert!(
        status_line.starts_with("HTTP/1.1 502"),
        "expected 502 on upstream connect failure, got: {status_line}"
    );

    started_proxy.server_handle.shutdown().await;
}

#[tokio::test]
async fn blind_tunnel_returns_200_when_upstream_accepts() {
    // Positive control: with a live upstream, the blind relay must still
    // send 200 Connection Established before relaying.
    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move {
        // Accept the proxied connection so TcpStream::connect succeeds.
        let _ = upstream_listener.accept().await;
    });

    let proxy_port = allocate_unused_port();
    let started_proxy = start_proxy_server(
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

    let status_line = send_connect_request_read_status_line(proxy_port, upstream_port).await;

    assert!(
        status_line.starts_with("HTTP/1.1 200"),
        "expected 200 Connection Established for live upstream, got: {status_line}"
    );

    started_proxy.server_handle.shutdown().await;
    upstream_task.await.unwrap();
}

// ---------------------------------------------------------------------------
// H3: send_direct_request must be bounded by an upstream timeout.
// A hanging upstream (accepts + reads request, then never responds) must NOT
// block send_direct_request forever — it must resolve within the timeout
// window and return an error (gateway-timeout semantics).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn direct_request_times_out_on_hanging_upstream() {
    let _timeout_guard = override_upstream_request_timeout_for_test(Duration::from_millis(200));

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        // Read the request, then hang — TCP stays open, no response.
        let mut buf = [0_u8; 1024];
        let _ = stream.read(&mut buf).await;
        tokio::time::sleep(Duration::from_secs(30)).await;
    });

    // Outer timeout (3s) is larger than the inner override (200ms): if
    // send_direct_request hangs, the outer timeout elapses and result.is_err().
    let result = timeout(
        Duration::from_secs(3),
        send_direct_request(
            "GET".to_string(),
            format!("http://127.0.0.1:{port}/"),
            Vec::new(),
            None,
        ),
    )
    .await;

    upstream.abort();

    assert!(result.is_ok(), "send_direct_request must not hang");
    let inner = result.unwrap();
    assert!(
        inner.is_err(),
        "send_direct_request must return an error on a hanging upstream"
    );
}

// ---------------------------------------------------------------------------
// H4: blind-tunnel relay must be bounded by an idle timeout.
//
// `tunnel_blind_relay` holds a semaphore permit (max 1024 concurrent conns).
// If an upstream accepts the TCP connection but then never speaks (idle), an
// unbounded `copy_bidirectional` would hold the permit forever, eventually
// exhausting the pool and rejecting all new connections. The relay must end
// within the idle-timeout window even when the upstream is silent.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn blind_tunnel_idle_upstream_times_out_and_releases_permit() {
    let _idle_guard = override_tunnel_idle_timeout_for_test(Duration::from_millis(200));

    // Upstream accepts the proxied TCP connection but then sleeps forever —
    // i.e. it never sends or receives any application bytes (idle tunnel).
    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (_stream, _addr) = upstream_listener.accept().await.unwrap();
        // Accept but never speak. Aborted at end of test.
        tokio::time::sleep(Duration::from_secs(30)).await;
    });

    let proxy_port = allocate_unused_port();
    let started_proxy = start_proxy_server(
        ProxyConfig {
            runtime: ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
                http2_enabled: None,
            },
            workspace_id: None,
            event_emitter: None,
        },
        // tls: None -> CONNECT goes through the blind relay (no MITM).
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

    let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    client
        .write_all(format!("CONNECT 127.0.0.1:{upstream_port} HTTP/1.1\r\n\r\n").as_bytes())
        .await
        .unwrap();

    // Read the 200 Connection Established head. The proxy writes this once the
    // upstream TCP connect succeeds, BEFORE entering copy_bidirectional.
    let mut head_buf = [0u8; 64];
    let head_n = timeout(Duration::from_secs(3), client.read(&mut head_buf))
        .await
        .expect("timed out waiting for 200 Connection Established")
        .unwrap();
    assert!(
        head_buf[..head_n].windows(6).any(|w| w == b"200 Co"),
        "expected 200 Connection Established, got: {}",
        String::from_utf8_lossy(&head_buf[..head_n])
    );

    // Now the relay is in copy_bidirectional with a silent upstream. The relay
    // MUST end within the (overridden) idle window — not hang for the upstream's
    // 30s sleep. We detect "relay ended" by a second read: with both sides idle
    // the client read would block forever until the proxy closes the tunnel
    // (idle timeout) and read returns Ok(0)/Err. The outer bound (3s) is much
    // larger than the 200ms override so a hanging relay fails clearly & fast.
    let relay_ended = timeout(Duration::from_secs(3), async {
        let mut buf = [0u8; 64];
        // Second read: no more data is coming (idle relay). Returns only
        // when the proxy closes the tunnel after the idle timeout.
        let _ = client.read(&mut buf).await;
    })
    .await;

    upstream.abort();
    started_proxy.server_handle.shutdown().await;

    assert!(
        relay_ended.is_ok(),
        "blind tunnel must end within the idle-timeout window, not hang for the upstream's sleep"
    );
}

// ---------------------------------------------------------------------------
// H4 (idle-reset): an ACTIVE long-lived tunnel must NOT be killed by the idle
// timeout. This is the regression the Phase 2 Task 6 review flagged: an overall
// cap (the old `timeout(idle, copy_bidirectional)`) kills legitimately quiet
// long-lived sessions (SSH-over-CONNECT, database tunnels, websocket-over-
// CONNECT). Only an IDLE-RESET — timer reset whenever bytes flow in EITHER
// direction — correctly distinguishes "hung/half-open" from "legitimately
// quiet long-lived".
//
// Here the idle override is 200ms but client + upstream exchange a byte every
// 100ms for 600ms (three times the idle window). The tunnel must SURVIVE the
// whole 600ms and only end once activity truly stops. If the relay used an
// overall cap it would end at ~200ms and the exchanges after that would fail.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn blind_tunnel_active_long_lived_survives_idle_timeout() {
    let _idle_guard = override_tunnel_idle_timeout_for_test(Duration::from_millis(200));

    // Upstream: accepts the proxied connection, then echoes back every byte it
    // receives at 100ms intervals for ~600ms. This keeps the tunnel alive well
    // past the 200ms idle window on BOTH directions (client->upstream writes
    // AND upstream->client echoes each reset the idle timer).
    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream = tokio::spawn(async move {
        let (mut stream, _addr) = upstream_listener.accept().await.unwrap();
        // Echo loop: read a byte, write it back, repeat every 100ms.
        // We do ~7 rounds (700ms) so the test clearly outlasts the 200ms idle.
        for _ in 0..7 {
            let mut byte = [0u8; 1];
            match stream.read(&mut byte).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let _ = stream.write_all(&byte).await;
                }
            }
        }
        // After the exchange loop ends the upstream side closes; the client
        // side will then observe EOF.
    });

    let proxy_port = allocate_unused_port();
    let started_proxy = start_proxy_server(
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

    let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    client
        .write_all(format!("CONNECT 127.0.0.1:{upstream_port} HTTP/1.1\r\n\r\n").as_bytes())
        .await
        .unwrap();

    // Read the 200 Connection Established head.
    let mut head_buf = [0u8; 64];
    let head_n = timeout(Duration::from_secs(3), client.read(&mut head_buf))
        .await
        .expect("timed out waiting for 200 Connection Established")
        .unwrap();
    assert!(
        head_buf[..head_n].windows(6).any(|w| w == b"200 Co"),
        "expected 200 Connection Established, got: {}",
        String::from_utf8_lossy(&head_buf[..head_n])
    );

    // Exchange a byte every 100ms for ~600ms — well past the 200ms idle window.
    // Each exchange MUST keep the tunnel alive (idle timer reset on BOTH the
    // client->upstream write and the upstream->client echo). With an overall
    // cap the tunnel would die at ~200ms and the 4th-6th exchanges would fail.
    let mut exchanged = 0usize;
    for i in 0..6 {
        sleep(Duration::from_millis(100)).await;
        // Write a byte to the upstream (through the tunnel).
        if client.write_all(&[b'A']).await.is_err() {
            break;
        }
        // Read the echoed byte back. Use a generous outer bound: if the tunnel
        // was killed by an overall cap, this read would return early (EOF/error)
        // and we'd exchange fewer bytes than expected.
        let mut echo = [0u8; 1];
        let res = timeout(Duration::from_secs(2), client.read(&mut echo)).await;
        match res {
            Ok(Ok(n)) if n > 0 => exchanged += 1,
            _ => break,
        }
        let _ = i; // suppress unused var
    }

    upstream.abort();
    started_proxy.server_handle.shutdown().await;

    // The tunnel must have survived long enough to complete MULTIPLE exchanges
    // that span well beyond the 200ms idle window. If the relay used an overall
    // cap it would have ended at ~200ms (1-2 exchanges at most). Require at
    // least 3 to prove the idle-reset is actually resetting on activity.
    assert!(
        exchanged >= 3,
        "active long-lived tunnel was killed by the idle timeout: only {exchanged} bytes exchanged across the 200ms idle window (need >= 3 to prove idle-reset)"
    );
}

// ---------------------------------------------------------------------------
// H9: WebSocket relay must terminate after Close even without peer closeback
// ---------------------------------------------------------------------------

/// Poll the global WS registry until the session reaches a terminal state
/// (Closed, which also covers unregistered entries). Returns true once
/// terminal, false if the deadline elapses first.
async fn wait_for_ws_registry_closed(session_id: &str, deadline: Duration) -> bool {
    let registry = crate::ws::global_ws_registry();
    let result = timeout(deadline, async {
        loop {
            if registry.get_status(session_id) == crate::ws::WsConnectionStatus::Closed {
                return;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    result.is_ok()
}

#[tokio::test]
async fn ws_relay_terminates_after_close_without_peer_closeback() {
    // Upstream upgrades, sends one Close frame to the client, then NEVER
    // closebacks: it keeps the TCP socket fully open (no FIN) and sends
    // nothing further. The client also stays connected and never sends a
    // Close. Without a close-grace timeout the relay would wait forever on
    // the client read. With H9 it must terminate within the grace window and
    // the registry must reach a terminal state.
    let _guard = crate::override_ws_close_grace_timeout_for_test(Duration::from_millis(300));

    let upstream_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let upstream_task = tokio::spawn(async move {
        let (mut stream, _) = upstream_listener.accept().await.unwrap();
        // Read the upgrade request.
        let mut buffer = [0u8; 2048];
        let _ = stream.read(&mut buffer).await.unwrap();
        // Answer 101 Switching Protocols.
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
        // Send one Close frame (server→client, unmasked, code 1000). The
        // relay forwards this to the client and marks upstream_done. Then we
        // HANG: keep the socket open, send nothing, never FIN. This simulates
        // a non-compliant / half-closed / packet-losing peer.
        let close_frame = [0x88u8, 0x02, 0x03, 0xE8]; // FIN+Close, len 2, code 1000
        stream.write_all(&close_frame).await.unwrap();
        // Hold the connection open until the test aborts us. We must NOT
        // shutdown()/close() — that would let the relay see clean EOF and
        // terminate regardless of the grace fix.
        sleep(Duration::from_secs(10)).await;
        let _ = stream;
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

    // Drive the upgrade through the proxy ourselves so we can KEEP the client
    // side alive (send_ws_upgrade_via_proxy drops the client stream on return,
    // which would half-close the client and let the relay exit on clean EOF —
    // not the scenario under test).
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

    // Read the 101 response from the proxy.
    let mut response_buf = [0u8; 4096];
    let _n = timeout(
        Duration::from_secs(3),
        client_stream.read(&mut response_buf),
    )
    .await
    .expect("timed out reading proxy 101 response")
    .unwrap();

    // Capture the WS session id from the first completed (status!=0) session.
    let completed_session = timeout(Duration::from_secs(2), async {
        loop {
            let session = started_proxy.session_receiver.recv().await.unwrap();
            if session.summary.status_code != 0 {
                break session;
            }
        }
    })
    .await
    .expect("timed out waiting for completed WS session");
    assert_eq!(completed_session.summary.status_code, 101);

    // Keep the client socket alive (do NOT shutdown) and DO NOT send a Close.
    // The relay must terminate within the grace window (300ms) purely from
    // the close-grace timeout firing after the upstream Close.
    let closed = wait_for_ws_registry_closed(
        &completed_session.id,
        // Generous outer bound: well beyond the 300ms grace, but far short of
        // the 30s+ a hung relay would take to trip the frame-read timeout.
        Duration::from_secs(2),
    )
    .await;

    upstream_task.abort();
    started_proxy.server_handle.shutdown().await;

    assert!(
        closed,
        "ws relay must terminate after Close even without peer closeback (within grace window)"
    );
}
