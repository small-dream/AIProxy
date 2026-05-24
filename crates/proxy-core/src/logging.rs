pub(crate) fn emit_log(level: &str, event: &str, fields: &[(&str, String)]) {
    let fields_ref: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
    match level {
        "ERROR" => tracing::error!(event, fields = ?fields_ref),
        "WARN" => tracing::warn!(event, fields = ?fields_ref),
        "INFO" => tracing::info!(event, fields = ?fields_ref),
        _ => tracing::debug!(event, fields = ?fields_ref),
    }
}
