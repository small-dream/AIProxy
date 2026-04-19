use super::{
    build_request_path, build_upstream_headers_from_entries, find_header_end, resolve_target_url,
    start_proxy_server, MapManager, MapRule, ParsedProxyRequest, ProxyHeaderEntry,
    ProxyRuntimeConfig, ProxySessionDetail, RewriteManager, RewriteRule, RewriteRuleMatch,
    StartedProxyServer, ThrottleManager, ThrottleProfileData,
};
use super::rules::{
    active_throttle_profile_for_workspace, apply_map_rules, apply_request_rewrite_rules,
};
use reqwest::header::HeaderMap;
use reqwest::{Method, Url};
use serde_json::json;
use std::{fs, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

    #[test]
    fn validates_a_non_zero_port() {
        let config = ProxyRuntimeConfig {
            port: 8888,
            ssl_enabled: true,
        };

        let actual = config.validate();

        assert_eq!(actual, Ok(()));
    }

    #[test]
    fn rejects_zero_as_a_port() {
        let config = ProxyRuntimeConfig {
            port: 0,
            ssl_enabled: false,
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

        apply_request_rewrite_rules(&Some(Arc::new(manager)), "default", &mut request).unwrap();

        assert_eq!(request.url.as_str(), "https://staging.example.com/api/users?lang=en&env=staging");
        assert_eq!(request.protocol, "https");
        assert_eq!(request.host, "staging.example.com");
        assert!(request
            .request_headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case("x-debug-mode") && header.value == "true"));
    }

    #[test]
    fn applies_map_local_rules_by_reading_a_local_file() {
        let file_path = std::env::temp_dir().join(format!("aiproxy-map-local-{}.txt", std::process::id()));
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
        let response = apply_map_rules(&Some(Arc::new(manager)), "default", &mut request)
            .unwrap()
            .unwrap();

        assert_eq!(response.status_code, reqwest::StatusCode::OK);
        assert_eq!(String::from_utf8(response.response_body).unwrap(), "mapped body");

        let _ = fs::remove_file(file_path);
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
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHello",
                )
                .await
                .unwrap();
        });

        let proxy_port = allocate_unused_port();
        let mut started_proxy: StartedProxyServer = start_proxy_server(
            ProxyRuntimeConfig {
                port: proxy_port,
                ssl_enabled: false,
            },
            None,
            None,
            None,
            None,
            None,
            None,
            Option::<String>::None,
            None,
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
        let session: ProxySessionDetail = started_proxy.session_receiver.recv().await.unwrap();

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
                .and_then(|body| body.inline_text.clone()),
            Some("Hello".to_string())
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

    fn build_test_request(url: &str) -> ParsedProxyRequest {
        let parsed_url = Url::parse(url).unwrap();
        let request_headers = vec![ProxyHeaderEntry {
            name: "Host".to_string(),
            value: match parsed_url.port() {
                Some(port) => format!("{}:{port}", parsed_url.host_str().unwrap_or_default()),
                None => parsed_url.host_str().unwrap_or_default().to_string(),
            },
        }];

        ParsedProxyRequest {
            body: Vec::new(),
            headers: build_upstream_headers_from_entries(&request_headers).unwrap_or_else(|_| HeaderMap::new()),
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
        }
    }
