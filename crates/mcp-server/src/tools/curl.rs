use std::collections::BTreeMap;

use aiproxy_db::sessions::{load_session_detail, load_session_summary};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::{HeaderEntry, Redactor};

use super::body::{load_body_reference, read_body_bytes, BodyPart, StoredBodyReference};
use super::sessions::{require_session_id, RedactionMode};

const MAX_INLINE_BODY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CurlShell {
    /// POSIX shell, including macOS and Linux (bash/zsh/sh).
    #[default]
    Posix,
    /// Windows PowerShell using curl.exe.
    Powershell,
}

impl CurlShell {
    fn as_str(self) -> &'static str {
        match self {
            Self::Posix => "posix",
            Self::Powershell => "powershell",
        }
    }

    fn command(self) -> &'static str {
        match self {
            Self::Posix => "curl",
            Self::Powershell => "curl.exe",
        }
    }

    fn quote_literal(self, value: &str) -> String {
        match self {
            Self::Posix => format!("'{}'", value.replace('\'', "'\\''")),
            Self::Powershell => format!("'{}'", value.replace('\'', "''")),
        }
    }

    fn env_value(self, name: &str) -> String {
        match self {
            Self::Posix => format!("\"${{{name}}}\""),
            Self::Powershell => format!("\"$env:{name}\""),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExportSessionAsCurlRequest {
    /// Exact session id or a unique prefix of at least 8 characters.
    pub session_id: String,
    /// Target shell syntax. Defaults to posix.
    #[serde(default)]
    pub shell: CurlShell,
    /// Include the request body when it is textual and at most 64 KiB. Defaults to true.
    #[serde(default = "default_true")]
    pub include_body: bool,
    /// redactedText replaces sensitive values with environment variables. Raw requires readRawBodies.
    #[serde(default)]
    pub redaction_mode: RedactionMode,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone)]
struct Placeholder {
    name: String,
    source: String,
}

struct Placeholders {
    marker_prefix: String,
    by_name: BTreeMap<String, String>,
    items: Vec<Placeholder>,
}

impl Default for Placeholders {
    fn default() -> Self {
        Self::new()
    }
}

impl Placeholders {
    fn new() -> Self {
        Self {
            // A per-export nonce ensures rendering only accepts markers created
            // by this export. Captured text cannot forge a marker that renders
            // as an environment expansion.
            marker_prefix: format!("__AIPROXY_ENV_{}_", uuid::Uuid::new_v4().simple()),
            by_name: BTreeMap::new(),
            items: Vec::new(),
        }
    }

    fn register(&mut self, base: &str, source: impl Into<String>) -> String {
        assert!(
            is_valid_env_name(base),
            "placeholder base must contain only A-Z, 0-9, and _"
        );
        let source = source.into();
        let mut candidate = base.to_string();
        let mut suffix = 2usize;
        while let Some(existing) = self.by_name.get(&candidate) {
            if existing == &source {
                return candidate;
            }
            candidate = format!("{base}_{suffix}");
            suffix += 1;
        }
        self.by_name.insert(candidate.clone(), source.clone());
        self.items.push(Placeholder {
            name: candidate.clone(),
            source,
        });
        candidate
    }

    fn marker(&mut self, base: &str, source: impl Into<String>) -> String {
        let name = self.register(base, source);
        format!("{}{}__", self.marker_prefix, name)
    }

    fn has_generated_marker(&self, name: &str) -> bool {
        is_valid_env_name(name) && self.by_name.contains_key(name)
    }

    fn into_json(self) -> Value {
        json!(self
            .items
            .into_iter()
            .map(|placeholder| json!({
                "name": placeholder.name,
                "source": placeholder.source,
            }))
            .collect::<Vec<_>>())
    }
}

pub async fn export_session_as_curl(
    state: &AppContext,
    request: ExportSessionAsCurlRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled. Enable readSessions in AIProxy Settings > Agent Access.",
        ));
    }
    let raw = request.redaction_mode == RedactionMode::Raw;
    if raw && !config.permissions.read_raw_bodies {
        return Err(ToolError::permission_denied(
            "Raw cURL export requires the readRawBodies permission. Enable it in AIProxy Settings > Agent Access.",
        ));
    }
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;
    let session_id = require_session_id(state, &request.session_id).await?;
    let session_id_for_query = session_id.clone();
    let (summary, detail, body_reference) = state
        .with_db(move |connection| {
            let summary = load_session_summary(connection, &session_id_for_query)?
                .ok_or_else(|| aiproxy_db::DbError::not_found("session", &session_id_for_query))?;
            let detail = load_session_detail(connection, &session_id_for_query)?;
            let body_reference =
                load_body_reference(connection, &session_id_for_query, BodyPart::Request)?;
            Ok((summary, detail, body_reference))
        })
        .await?;
    let Some(detail) = detail else {
        return Err(ToolError::new(
            "SESSION_DETAIL_UNAVAILABLE",
            "The session details required for a cURL export were not captured.",
        ));
    };

    let mut placeholders = Placeholders::default();
    let mut omitted = Vec::<Value>::new();
    let mut warnings = Vec::<String>::new();

    let url = export_url(&summary.url, raw, &redactor, &mut placeholders)?;
    let headers =
        serde_json::from_str::<Vec<HeaderEntry>>(&detail.request_headers).unwrap_or_default();
    let mut command_parts = vec![
        request.shell.command().to_string(),
        "--request".to_string(),
        request.shell.quote_literal(&summary.method),
        "--url".to_string(),
        render_with_markers(&url, request.shell, &placeholders),
    ];

    let mut has_accept_encoding = false;
    for header in headers {
        if should_skip_header(&header) {
            continue;
        }
        if header.name.eq_ignore_ascii_case("accept-encoding") {
            has_accept_encoding = true;
        }
        let value = export_header_value(&header, raw, &redactor, &mut placeholders);
        let argument = format!("{}: {}", header.name, value);
        command_parts.push("--header".to_string());
        command_parts.push(render_with_markers(&argument, request.shell, &placeholders));
    }

    if has_accept_encoding {
        command_parts.push("--compressed".to_string());
    }
    if summary.http_version == "2" || summary.protocol.to_ascii_lowercase().contains("http/2") {
        command_parts.push("--http2".to_string());
    }

    if let Some(reference) = body_reference.as_ref() {
        if !request.include_body {
            omitted.push(json!({ "reason": "includeBody=false", "source": "body:request" }));
        } else if !config.permissions.read_bodies {
            omitted.push(json!({
                "reason": "readBodies permission is not granted",
                "source": "body:request"
            }));
            warnings.push(
                "Request body omitted because readBodies is disabled. Enable it to include textual bodies in the generated command."
                    .to_string(),
            );
        } else {
            export_body(
                state,
                reference,
                raw,
                &redactor,
                &mut placeholders,
                &mut omitted,
                &mut warnings,
                &mut command_parts,
                request.shell,
            )?;
        }
    }

    let data = json!({
        "command": command_parts.join(" "),
        "shell": request.shell.as_str(),
        "placeholders": placeholders.into_json(),
        "omitted": omitted,
        "warnings": warnings,
        "sessionId": summary.id,
    });
    Ok((data, ToolMeta::new(false, !raw, None)))
}

fn export_url(
    url: &str,
    raw: bool,
    redactor: &Redactor,
    placeholders: &mut Placeholders,
) -> Result<String, ToolError> {
    if raw {
        return Ok(url.to_string());
    }
    let parsed = Url::parse(url).map_err(|error| {
        ToolError::invalid(format!(
            "The captured request URL cannot be exported: {error}"
        ))
    })?;
    let pairs = parsed
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if pairs.is_empty() {
        return Ok(url.to_string());
    }
    let mut base = parsed.clone();
    base.set_query(None);
    base.set_fragment(None);
    let mut query = Vec::with_capacity(pairs.len());
    for (name, value) in pairs {
        let encoded_name = encode_component(&name);
        let redacted = redactor.redact_text(&value).value;
        let rendered_value = if redactor.is_sensitive_value_name(&name) || redacted != value {
            placeholders.marker(
                &format!("AIPROXY_QUERY_{}", env_segment(&name)),
                format!("query:{name}"),
            )
        } else {
            encode_component(&value)
        };
        query.push(format!("{encoded_name}={rendered_value}"));
    }
    Ok(format!("{}?{}", base.as_str(), query.join("&")))
}

fn export_header_value(
    header: &HeaderEntry,
    raw: bool,
    redactor: &Redactor,
    placeholders: &mut Placeholders,
) -> String {
    if raw {
        return header.value.clone();
    }
    let redacted = redactor.redact_text(&header.value).value;
    if redactor.is_sensitive_value_name(&header.name) || redacted != header.value {
        placeholders.marker(
            &format!("AIPROXY_{}", env_segment(&header.name)),
            format!("header:{}", header.name),
        )
    } else {
        header.value.clone()
    }
}

#[allow(clippy::too_many_arguments)]
fn export_body(
    state: &AppContext,
    reference: &StoredBodyReference,
    raw: bool,
    redactor: &Redactor,
    placeholders: &mut Placeholders,
    omitted: &mut Vec<Value>,
    warnings: &mut Vec<String>,
    command_parts: &mut Vec<String>,
    shell: CurlShell,
) -> Result<(), ToolError> {
    let page = read_body_bytes(&state.body_store, reference, 0, MAX_INLINE_BODY_BYTES + 1)?;
    if page.decoded_size_bytes > MAX_INLINE_BODY_BYTES as u64 {
        omitted.push(json!({
            "reason": "body exceeds 64 KiB inline limit",
            "source": "body:request",
            "decodedSizeBytes": page.decoded_size_bytes,
        }));
        return Ok(());
    }
    let Ok(text) = std::str::from_utf8(&page.bytes) else {
        omitted.push(json!({ "reason": "binary body", "source": "body:request" }));
        return Ok(());
    };
    if text.is_empty() {
        return Ok(());
    }

    let body = if raw {
        text.to_string()
    } else if let Ok(mut value) = serde_json::from_str::<Value>(text) {
        replace_json_placeholders(&mut value, "$", redactor, placeholders);
        serde_json::to_string(&value).unwrap_or_else(|_| text.to_string())
    } else {
        let redacted = redactor.redact_text(text);
        if redacted.value != text {
            placeholders.marker("AIPROXY_BODY", "body:request")
        } else {
            text.to_string()
        }
    };
    command_parts.push("--data-raw".to_string());
    command_parts.push(render_with_markers(&body, shell, placeholders));
    if !raw && body.contains(placeholders.marker_prefix.as_str()) {
        warnings.push(
            "Replace environment variables with values from the placeholders list before running the command."
                .to_string(),
        );
    }
    Ok(())
}

fn replace_json_placeholders(
    value: &mut Value,
    path: &str,
    redactor: &Redactor,
    placeholders: &mut Placeholders,
) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let child_path = format!("{path}.{key}");
                if redactor.is_sensitive_value_name(key) {
                    *child = Value::String(placeholders.marker(
                        &format!("AIPROXY_BODY_{}", env_segment(key)),
                        format!("body:{child_path}"),
                    ));
                } else {
                    replace_json_placeholders(child, &child_path, redactor, placeholders);
                }
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter_mut().enumerate() {
                replace_json_placeholders(
                    child,
                    &format!("{path}[{index}]"),
                    redactor,
                    placeholders,
                );
            }
        }
        Value::String(text) => {
            let redacted = redactor.redact_text(text);
            if redacted.value != *text {
                *text = placeholders.marker("AIPROXY_BODY_VALUE", format!("body:{path}"));
            }
        }
        _ => {}
    }
}

fn render_with_markers(value: &str, shell: CurlShell, placeholders: &Placeholders) -> String {
    let mut output = String::new();
    let mut literal_start = 0usize;
    let mut search_start = 0usize;
    while let Some(relative) = value[search_start..].find(&placeholders.marker_prefix) {
        let marker_start = search_start + relative;
        let name_start = marker_start + placeholders.marker_prefix.len();
        let marker = value[name_start..]
            .find("__")
            .map(|offset| {
                let name = &value[name_start..name_start + offset];
                (name, name_start + offset + 2)
            })
            .filter(|(name, _)| placeholders.has_generated_marker(name));

        if let Some((name, marker_end)) = marker {
            if literal_start < marker_start {
                output.push_str(&shell.quote_literal(&value[literal_start..marker_start]));
            }
            output.push_str(&shell.env_value(name));
            literal_start = marker_end;
            search_start = marker_end;
        } else {
            // Keep an unrecognized prefix in the literal segment. This also
            // covers captured text that happens to contain the old marker
            // syntax or an invalid environment-variable name.
            search_start = name_start;
        }
    }
    if literal_start < value.len() {
        output.push_str(&shell.quote_literal(&value[literal_start..]));
    }
    if output.is_empty() {
        output.push_str(&shell.quote_literal(""));
    }
    output
}

fn is_valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn encode_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn env_segment(value: &str) -> String {
    let mut output = String::new();
    let mut previous_separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character.to_ascii_uppercase());
            previous_separator = false;
        } else if !previous_separator && !output.is_empty() {
            output.push('_');
            previous_separator = true;
        }
    }
    while output.ends_with('_') {
        output.pop();
    }
    if output.is_empty() {
        "VALUE".to_string()
    } else {
        output
    }
}

fn should_skip_header(header: &HeaderEntry) -> bool {
    if header.is_pseudo.unwrap_or(false) || header.name.starts_with(':') {
        return true;
    }
    matches!(
        header.name.trim().to_ascii_lowercase().as_str(),
        "host"
            | "content-length"
            | "connection"
            | "proxy-connection"
            | "keep-alive"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_quotes_special_characters() {
        assert_eq!(
            CurlShell::Posix.quote_literal("a'b $HOME `x`"),
            "'a'\\''b $HOME `x`'"
        );
    }

    #[test]
    fn powershell_quotes_special_characters() {
        assert_eq!(
            CurlShell::Powershell.quote_literal("a'b $HOME"),
            "'a''b $HOME'"
        );
    }

    #[test]
    fn markers_become_environment_segments() {
        let mut placeholders = Placeholders::default();
        let marker = placeholders.marker("AIPROXY_AUTHORIZATION", "header:Authorization");
        let rendered = render_with_markers(
            &format!("Authorization: {marker}"),
            CurlShell::Posix,
            &placeholders,
        );
        assert_eq!(rendered, "'Authorization: '\"${AIPROXY_AUTHORIZATION}\"");
    }

    #[test]
    fn captured_marker_text_is_quoted_as_a_literal() {
        let placeholders = Placeholders::default();
        let payload = "X-Test: __AIPROXY_ENV_A}$(touch /tmp/aiproxy-pwned)${B__";
        let rendered = render_with_markers(payload, CurlShell::Posix, &placeholders);
        assert_eq!(rendered, CurlShell::Posix.quote_literal(payload));

        let invalid_name = format!(
            "X-Test: {}A}}$(touch /tmp/aiproxy-pwned)${{B__",
            placeholders.marker_prefix
        );
        let rendered_invalid = render_with_markers(&invalid_name, CurlShell::Posix, &placeholders);
        assert_eq!(
            rendered_invalid,
            CurlShell::Posix.quote_literal(&invalid_name)
        );
    }

    #[test]
    fn unregistered_valid_marker_names_stay_literal() {
        let placeholders = Placeholders::default();
        let unregistered = format!("{}UNTRUSTED__", placeholders.marker_prefix);
        let rendered = render_with_markers(&unregistered, CurlShell::Powershell, &placeholders);
        assert_eq!(rendered, CurlShell::Powershell.quote_literal(&unregistered));
    }

    #[test]
    fn env_names_do_not_contain_original_values() {
        assert_eq!(env_segment("X-Api-Key"), "X_API_KEY");
        assert_eq!(env_segment("员工-token"), "TOKEN");
    }

    #[test]
    fn json_body_fields_are_replaced_without_exposing_values() {
        let redactor = Redactor::from_config(
            &crate::config::AgentAccessConfig::default(),
            std::path::Path::new("/tmp/aiproxy-curl-test"),
        )
        .unwrap();
        let mut placeholders = Placeholders::default();
        let mut body = json!({
            "token": "secret-value",
            "message": "hello",
            "nested": { "password": "pwd" }
        });
        replace_json_placeholders(&mut body, "$", &redactor, &mut placeholders);
        let rendered = body.to_string();
        assert!(!rendered.contains("secret-value"));
        assert!(!rendered.contains("pwd"));
        assert!(rendered.contains(&placeholders.marker_prefix));
        assert_eq!(placeholders.items.len(), 2);
    }

    #[test]
    fn sensitive_header_values_become_placeholders() {
        let redactor = Redactor::from_config(
            &crate::config::AgentAccessConfig::default(),
            std::path::Path::new("/tmp/aiproxy-curl-test"),
        )
        .unwrap();
        let mut placeholders = Placeholders::default();
        let value = export_header_value(
            &HeaderEntry {
                name: "Authorization".to_string(),
                value: "Bearer secret".to_string(),
                is_pseudo: None,
            },
            false,
            &redactor,
            &mut placeholders,
        );
        assert_eq!(
            value,
            placeholders.marker("AIPROXY_AUTHORIZATION", "header:Authorization")
        );
        assert_eq!(placeholders.items[0].source, "header:Authorization");
    }

    #[test]
    fn query_values_are_rebuilt_with_placeholders() {
        let redactor = Redactor::from_config(
            &crate::config::AgentAccessConfig::default(),
            std::path::Path::new("/tmp/aiproxy-curl-test"),
        )
        .unwrap();
        let mut placeholders = Placeholders::default();
        let url = export_url(
            "https://api.example.com/v1?token=secret&page=2",
            false,
            &redactor,
            &mut placeholders,
        )
        .unwrap();
        assert!(url.contains(&format!(
            "token={}",
            placeholders.marker("AIPROXY_QUERY_TOKEN", "query:token")
        )));
        assert!(url.contains("page=2"));
        assert!(!url.contains("secret"));
    }
}
