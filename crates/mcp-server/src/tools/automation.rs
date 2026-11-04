use aiproxy_agent_control::{
    ApplyAutomationPlanParams, ClearAgentAutomationParams, ControlOperation,
    GetAutomationChangeParams, GetAutomationResourceParams, ListAutomationResourcesParams,
    RollbackAutomationChangeParams, ValidateAutomationPlanParams, VerifyAutomationChangeParams,
};

use crate::context::AppContext;
use crate::control_client::{call_control, ControlCaller};
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::Redactor;
use crate::tools::control::{ensure_audit, ensure_permission, ToolResult};

pub async fn list_automation_resources(
    state: &AppContext,
    params: ListAutomationResourcesParams,
    caller: ControlCaller<'_>,
) -> ToolResult {
    run_control(
        state,
        ControlOperation::ListAutomationResources(params),
        caller,
        false,
    )
    .await
}

pub async fn get_automation_resource(
    state: &AppContext,
    params: GetAutomationResourceParams,
    caller: ControlCaller<'_>,
) -> ToolResult {
    run_control(
        state,
        ControlOperation::GetAutomationResource(params),
        caller,
        false,
    )
    .await
}

pub async fn validate_automation_plan(
    state: &AppContext,
    params: ValidateAutomationPlanParams,
    caller: ControlCaller<'_>,
) -> ToolResult {
    run_control(
        state,
        ControlOperation::ValidateAutomationPlan(params),
        caller,
        false,
    )
    .await
}

pub async fn apply_automation_plan(
    state: &AppContext,
    params: ApplyAutomationPlanParams,
    caller: ControlCaller<'_>,
) -> ToolResult {
    run_control(
        state,
        ControlOperation::ApplyAutomationPlan(params),
        caller,
        true,
    )
    .await
}

pub async fn verify_automation_change(
    state: &AppContext,
    params: VerifyAutomationChangeParams,
    caller: ControlCaller<'_>,
) -> ToolResult {
    // A proxy verification is a controlled request even though the control
    // operation itself is classified as read-only for retry semantics.
    let is_write = params.mode == "proxy";
    run_control(
        state,
        ControlOperation::VerifyAutomationChange(params),
        caller,
        is_write,
    )
    .await
}

pub async fn get_automation_change(
    state: &AppContext,
    params: GetAutomationChangeParams,
    caller: ControlCaller<'_>,
) -> ToolResult {
    run_control(
        state,
        ControlOperation::GetAutomationChange(params),
        caller,
        false,
    )
    .await
}

pub async fn rollback_automation_change(
    state: &AppContext,
    params: RollbackAutomationChangeParams,
    caller: ControlCaller<'_>,
) -> ToolResult {
    run_control(
        state,
        ControlOperation::RollbackAutomationChange(params),
        caller,
        true,
    )
    .await
}

pub async fn clear_agent_automation(
    state: &AppContext,
    params: ClearAgentAutomationParams,
    caller: ControlCaller<'_>,
) -> ToolResult {
    run_control(
        state,
        ControlOperation::ClearAgentAutomation(params),
        caller,
        true,
    )
    .await
}

async fn run_control(
    state: &AppContext,
    operation: ControlOperation,
    caller: ControlCaller<'_>,
    requires_audit: bool,
) -> ToolResult {
    let config = state.config()?;
    ensure_permission(&config, &operation)?;
    if requires_audit {
        ensure_audit(state)?;
    }
    let value = call_control(&state.paths, operation, true, caller).await?;
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|error| ToolError::new("INVALID_REDACTION_CONFIG", error))?;
    let mut records = Vec::new();
    let mut value = value;
    redact_automation_value(&mut value, "$", &redactor, &mut records);
    Ok((value, ToolMeta::new(false, !records.is_empty(), None)))
}

pub fn action_summary(operation: &ControlOperation) -> String {
    operation.action_summary()
}

#[allow(dead_code)]
fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new("INVALID_ARGUMENT", message)
}

fn redact_automation_value(
    value: &mut serde_json::Value,
    path: &str,
    redactor: &Redactor,
    records: &mut Vec<crate::redaction::RedactionRecord>,
) {
    match value {
        serde_json::Value::String(text) => {
            let redacted = redactor.redact_text(text);
            *text = redacted.value;
            records.extend(redacted.records);
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                redact_automation_value(item, &format!("{path}[{index}]"), redactor, records);
            }
        }
        serde_json::Value::Object(object) => {
            let named_value = ["headerName", "paramName", "name"]
                .iter()
                .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
                .map(str::to_string);
            if let (Some(name), Some(serde_json::Value::String(value))) =
                (named_value.as_deref(), object.get_mut("value"))
            {
                let redacted = redactor.redact_named_value(name, value);
                *value = redacted.value;
                records.extend(redacted.records);
            }
            if let Some(field_name) = assertion_sensitive_field_name(object, redactor) {
                for key in ["actual", "expected"] {
                    if let Some(item) = object.get_mut(key) {
                        redactor.redact_json_field(
                            &field_name,
                            item,
                            &format!("{path}.{key}"),
                            records,
                        );
                    }
                }
                if object.contains_key("actual") {
                    let passed = object
                        .get("passed")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    if let Some(message) = object.get_mut("message") {
                        *message = serde_json::Value::String(if passed {
                            "assertion passed; actual value redacted".to_string()
                        } else {
                            "assertion failed; actual value redacted".to_string()
                        });
                    }
                }
            }
            for (key, item) in object.iter_mut() {
                let next = format!("{path}.{key}");
                if matches!(
                    key.as_str(),
                    "url"
                        | "finalUrl"
                        | "mappedUrl"
                        | "targetUrl"
                        | "originalUrl"
                        | "redirectTarget"
                        | "requestUrl"
                        | "responseUrl"
                        | "sourcePattern"
                        | "targetValue"
                        | "approvedPath"
                ) {
                    if let serde_json::Value::String(url) = item {
                        let redacted = redactor.redact_url(url);
                        if redacted != *url {
                            records.push(crate::redaction::RedactionRecord {
                                path: next.clone(),
                                rule: "url-query".to_string(),
                                action: "redact".to_string(),
                            });
                            *url = redacted;
                        }
                        continue;
                    }
                }
                if redactor.redact_json_field(key, item, &next, records) {
                    continue;
                }
                redact_automation_value(item, &next, redactor, records);
            }
        }
        _ => {}
    }
}

fn assertion_sensitive_field_name(
    object: &serde_json::Map<String, serde_json::Value>,
    redactor: &Redactor,
) -> Option<String> {
    let subject = object.get("subject").and_then(serde_json::Value::as_str)?;
    let path = object
        .get("path")
        .and_then(serde_json::Value::as_str)?
        .trim();
    if path.is_empty() {
        return None;
    }
    let field_name = match subject {
        "requestHeader" | "responseHeader" | "queryParam" => path,
        "responseBody" | "ruleTrace" => path
            .rsplit(['.', '[', ']'])
            .find(|segment| !segment.is_empty())?
            .trim_matches(['\'', '"']),
        _ => return None,
    };
    redactor
        .is_sensitive_name(field_name)
        .then(|| field_name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AgentAccessConfig;

    #[test]
    fn automation_output_redacts_header_and_body_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let redactor =
            Redactor::from_config(&AgentAccessConfig::default(), directory.path()).unwrap();
        let mut value = serde_json::json!({
            "headers": [
                { "name": "Authorization", "value": "Bearer secret-value" }
            ],
            "rewrite": {
                "actions": [{
                    "rewriteType": "header",
                    "payload": {
                        "headerName": "Authorization",
                        "value": "another-secret-value"
                    }
                }]
            },
            "jsonProperty": {
                "access_token": "json-property-secret"
            },
            "redirect": {
                "targetUrl": "https://api.example.com/callback?access_token=url-query-secret"
            },
            "assertions": [{
                "id": "authorization-header",
                "subject": "responseHeader",
                "path": "Authorization",
                "passed": false,
                "message": "expected equals Bearer assertion-secret, actual Bearer assertion-secret",
                "actual": "Bearer assertion-secret"
            }],
            "actual": {
                "body": "{\"access_token\":\"secret-value\"}"
            }
        });
        let mut records = Vec::new();
        redact_automation_value(&mut value, "$", &redactor, &mut records);
        let rendered = value.to_string();
        for secret in [
            "secret-value",
            "another-secret-value",
            "json-property-secret",
            "url-query-secret",
            "assertion-secret",
        ] {
            assert!(!rendered.contains(secret), "{secret} leaked: {rendered}");
        }
        assert!(!records.is_empty());
    }
}
