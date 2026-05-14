use super::common::*;
use chrono::Utc;
use serde_json::json;
use std::time::Duration;

const DEFAULT_PROVIDER: &str = "openai-compatible";
const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-4.1-mini";
const DEFAULT_TEMPERATURE: f64 = 0.2;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_AI_PAYLOAD_BYTES: usize = 96 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsPublic {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
    pub masked_api_key: Option<String>,
    pub temperature: f64,
    pub timeout_ms: u64,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiSettingsInput {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub clear_api_key: Option<bool>,
    pub temperature: f64,
    pub timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestAiConnectionResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiffSummaryRequest {
    pub payload: serde_json::Value,
    pub language: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiffSummaryResult {
    pub summary: String,
    pub model: String,
    pub provider: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessageResponse,
}

#[derive(Debug, Deserialize)]
struct ChatMessageResponse {
    content: Option<String>,
}

#[tauri::command]
pub async fn get_ai_settings(state: State<'_, Arc<AppState>>) -> Result<AiSettingsPublic, String> {
    let db = Arc::clone(state.read_db_connection());

    run_blocking_command("get_ai_settings", move || {
        let conn = db.lock().map_err(|_| "db mutex poisoned".to_string())?;
        let row = aiproxy_db::ai::load_ai_settings(&conn)?;
        Ok(row_to_public(row.as_ref()))
    })
    .await
}

#[tauri::command]
pub async fn save_ai_settings(
    input: SaveAiSettingsInput,
    state: State<'_, Arc<AppState>>,
) -> Result<AiSettingsPublic, String> {
    validate_provider(&input.provider)?;
    let base_url = normalize_base_url(&input.base_url)?;
    let model = input.model.trim().to_string();
    if model.is_empty() {
        return Err(app_error("INVALID_AI_SETTINGS", "Model is required."));
    }
    let temperature = input.temperature.clamp(0.0, 2.0);
    let timeout_ms = input.timeout_ms.clamp(5_000, 180_000);
    let db = Arc::clone(state.read_db_connection());

    run_blocking_command("save_ai_settings", move || {
        let conn = db.lock().map_err(|_| "db mutex poisoned".to_string())?;
        let existing = aiproxy_db::ai::load_ai_settings(&conn)?;
        let existing_api_key = existing.as_ref().map(|row| row.api_key.as_str()).unwrap_or("");
        let api_key = if input.clear_api_key.unwrap_or(false) {
            String::new()
        } else if let Some(api_key) = input.api_key {
            if api_key.trim().is_empty() {
                existing_api_key.to_string()
            } else {
                api_key.trim().to_string()
            }
        } else {
            existing_api_key.to_string()
        };

        let row = aiproxy_db::ai::AiSettingsRow {
            provider: DEFAULT_PROVIDER.to_string(),
            base_url,
            model,
            api_key,
            temperature,
            timeout_ms,
            updated_at: Utc::now().to_rfc3339(),
        };
        aiproxy_db::ai::upsert_ai_settings(&conn, &row)?;
        Ok(row_to_public(Some(&row)))
    })
    .await
}

#[tauri::command]
pub async fn test_ai_connection(state: State<'_, Arc<AppState>>) -> Result<TestAiConnectionResult, String> {
    let settings = load_configured_ai_settings(state.inner()).await?;
    let result = call_chat_completion(
        &settings,
        "Reply with exactly: ok",
        "ok",
        0.0,
    )
    .await;

    match result {
        Ok(_) => Ok(TestAiConnectionResult {
            ok: true,
            message: "AI connection succeeded.".to_string(),
        }),
        Err(error) => Ok(TestAiConnectionResult {
            ok: false,
            message: error,
        }),
    }
}

#[tauri::command]
pub async fn summarize_session_diff(
    input: SessionDiffSummaryRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<SessionDiffSummaryResult, String> {
    let settings = load_configured_ai_settings(state.inner()).await?;
    let payload_text = serde_json::to_string_pretty(&input.payload)
        .map_err(|error| format!("serialize diff payload: {error}"))?;
    if payload_text.len() > MAX_AI_PAYLOAD_BYTES {
        return Err(app_error(
            "AI_PAYLOAD_TOO_LARGE",
            "The diff is too large to summarize. Try disabling body context or comparing smaller sessions.",
        ));
    }

    let language = if input.language == "zh-CN" {
        "简体中文"
    } else {
        "English"
    };
    let system_prompt = format!(
        "You are AIProxy's network debugging assistant. Analyze a redacted HTTP session diff. \
         Answer in {language}. Use these exact sections: 核心结论, 关键差异, 可能原因, 建议验证步骤, 风险 / 注意事项. \
         Be concise, specific, and avoid inventing facts not present in the diff."
    );
    let user_prompt = format!("Session diff payload:\n{payload_text}");
    let summary = call_chat_completion(
        &settings,
        &system_prompt,
        &user_prompt,
        settings.temperature,
    )
    .await?;

    Ok(SessionDiffSummaryResult {
        summary,
        model: settings.model,
        provider: settings.provider,
        created_at: Utc::now().to_rfc3339(),
    })
}

async fn load_configured_ai_settings(app_state: &AppState) -> Result<aiproxy_db::ai::AiSettingsRow, String> {
    let db = Arc::clone(app_state.read_db_connection());
    let row = run_blocking_command("load_configured_ai_settings", move || {
        let conn = db.lock().map_err(|_| "db mutex poisoned".to_string())?;
        aiproxy_db::ai::load_ai_settings(&conn)
    })
    .await?
    .ok_or_else(|| app_error("AI_NOT_CONFIGURED", "Configure an AI model in Settings first."))?;

    if row.api_key.trim().is_empty() {
        return Err(app_error("AI_API_KEY_MISSING", "Configure an AI API key in Settings first."));
    }

    Ok(row)
}

async fn call_chat_completion(
    settings: &aiproxy_db::ai::AiSettingsRow,
    system_prompt: &str,
    user_prompt: &str,
    temperature: f64,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(settings.timeout_ms))
        .build()
        .map_err(|error| format!("create ai http client: {error}"))?;
    let endpoint = chat_completions_url(&settings.base_url)?;
    let response = client
        .post(endpoint)
        .bearer_auth(settings.api_key.trim())
        .json(&json!({
            "model": settings.model,
            "temperature": temperature,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("AI request failed: {error}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("read AI response: {error}"))?;

    if !status.is_success() {
        return Err(format!("AI request failed with HTTP {status}: {}", truncate_for_error(&text)));
    }

    let parsed: ChatCompletionResponse = serde_json::from_str(&text)
        .map_err(|error| format!("parse AI response: {error}"))?;
    parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_ref())
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "AI response did not include any summary text.".to_string())
}

fn row_to_public(row: Option<&aiproxy_db::ai::AiSettingsRow>) -> AiSettingsPublic {
    match row {
        Some(row) => AiSettingsPublic {
            provider: row.provider.clone(),
            base_url: row.base_url.clone(),
            model: row.model.clone(),
            has_api_key: !row.api_key.trim().is_empty(),
            masked_api_key: mask_api_key(&row.api_key),
            temperature: row.temperature,
            timeout_ms: row.timeout_ms,
            updated_at: Some(row.updated_at.clone()),
        },
        None => AiSettingsPublic {
            provider: DEFAULT_PROVIDER.to_string(),
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            has_api_key: false,
            masked_api_key: None,
            temperature: DEFAULT_TEMPERATURE,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            updated_at: None,
        },
    }
}

fn mask_api_key(api_key: &str) -> Option<String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return None;
    }
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Some(format!("**** {suffix}"))
}

fn validate_provider(provider: &str) -> Result<(), String> {
    if provider == DEFAULT_PROVIDER {
        Ok(())
    } else {
        Err(app_error("UNSUPPORTED_AI_PROVIDER", "Only OpenAI-compatible providers are supported."))
    }
}

fn normalize_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(app_error("INVALID_AI_SETTINGS", "Base URL is required."));
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| app_error("INVALID_AI_SETTINGS", "Enter a valid HTTP or HTTPS Base URL."))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(app_error("INVALID_AI_SETTINGS", "Base URL must start with http:// or https://."));
    }
    Ok(trimmed.to_string())
}

fn chat_completions_url(base_url: &str) -> Result<String, String> {
    let normalized = normalize_base_url(base_url)?;
    if normalized.ends_with("/chat/completions") {
        return Ok(normalized);
    }
    if normalized.ends_with("/v1") {
        return Ok(format!("{normalized}/chat/completions"));
    }
    Ok(format!("{normalized}/v1/chat/completions"))
}

fn truncate_for_error(value: &str) -> String {
    const LIMIT: usize = 512;
    if value.len() <= LIMIT {
        return value.to_string();
    }
    format!("{}...", &value[..LIMIT])
}

fn app_error(code: &str, message: &str) -> String {
    json!({
        "code": code,
        "message": message,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_api_key_without_returning_plaintext() {
        assert_eq!(mask_api_key("sk-abcdef123456"), Some("**** 3456".to_string()));
        assert_eq!(mask_api_key(""), None);
    }

    #[test]
    fn builds_chat_completion_url_from_base_url() {
        assert_eq!(
            chat_completions_url("https://example.test/v1").unwrap(),
            "https://example.test/v1/chat/completions",
        );
        assert_eq!(
            chat_completions_url("https://example.test").unwrap(),
            "https://example.test/v1/chat/completions",
        );
        assert_eq!(
            chat_completions_url("https://example.test/v1/chat/completions").unwrap(),
            "https://example.test/v1/chat/completions",
        );
    }

    #[test]
    fn rejects_non_http_base_url() {
        assert!(normalize_base_url("file:///tmp/model").is_err());
    }
}
