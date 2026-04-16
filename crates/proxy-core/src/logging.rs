use super::*;

pub(crate) fn emit_log(level: &str, event: &str, fields: &[(&str, String)]) {
    let timestamp = Utc::now().to_rfc3339();
    let mut line = format!("timestamp={timestamp} level={level} component=proxy-core event={event}");

    for (name, value) in fields {
        line.push(' ');
        line.push_str(name);
        line.push('=');
        line.push_str(&quote_value(value));
    }

    eprintln!("{line}");
    append_to_log_file(&line);
}

fn append_to_log_file(line: &str) {
    let write_lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _write_guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
    let log_file_path = resolve_log_file_path();

    if let Some(parent) = log_file_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn resolve_log_file_path() -> PathBuf {
    if let Ok(log_file) = env::var(DEV_LOG_ENV_VAR) {
        if !log_file.trim().is_empty() {
            return PathBuf::from(log_file);
        }
    }

    discover_workspace_root_from_current_exe()
        .unwrap_or_else(|| env::temp_dir().join("aiproxy-dev"))
        .join("logs")
        .join("dev")
        .join(DEV_LOG_FILE_NAME)
}

fn discover_workspace_root_from_current_exe() -> Option<PathBuf> {
    let current_exe = env::current_exe().ok()?;

    for ancestor in current_exe.ancestors() {
        if ancestor.file_name() == Some(OsStr::new("target")) {
            return ancestor.parent().map(Path::to_path_buf);
        }
    }

    None
}

fn quote_value(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");

    format!("\"{escaped}\"")
}
