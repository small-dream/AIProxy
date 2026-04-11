use chrono::Utc;
use std::{
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::Write,
    panic,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const DEV_LOG_ENV_VAR: &str = "PHARLES_DEV_LOG_FILE";
const DEV_LOG_FILE_NAME: &str = "pharles-desktop-dev.log";

static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn initialize() -> Result<PathBuf, String> {
    let log_file_path = resolve_log_file_path();

    if let Some(parent) = log_file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create Pharles development log directory {}: {error}",
                parent.display()
            )
        })?;
    }

    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
        .map_err(|error| {
            format!(
                "failed to open Pharles development log file {}: {error}",
                log_file_path.display()
            )
        })?;

    env::set_var(DEV_LOG_ENV_VAR, &log_file_path);
    install_panic_hook(log_file_path.clone());

    log_info(
        "desktop.app",
        "logger_initialized",
        &[("log_file", log_file_path.display().to_string())],
    );

    Ok(log_file_path)
}

pub fn log_debug(component: &str, event: &str, fields: &[(&str, String)]) {
    emit_log("DEBUG", component, event, fields);
}

pub fn log_info(component: &str, event: &str, fields: &[(&str, String)]) {
    emit_log("INFO", component, event, fields);
}

pub fn log_warn(component: &str, event: &str, fields: &[(&str, String)]) {
    emit_log("WARN", component, event, fields);
}

pub fn log_error(component: &str, event: &str, fields: &[(&str, String)]) {
    emit_log("ERROR", component, event, fields);
}

fn emit_log(level: &str, component: &str, event: &str, fields: &[(&str, String)]) {
    let timestamp = Utc::now().to_rfc3339();
    let mut line = format!("timestamp={timestamp} level={level} component={component} event={event}");

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
    let _write_guard = write_lock.lock().expect("log write mutex should not be poisoned");

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

fn install_panic_hook(log_file_path: PathBuf) {
    let previous_hook = panic::take_hook();

    panic::set_hook(Box::new(move |panic_info| {
        let payload = if let Some(message) = panic_info.payload().downcast_ref::<&str>() {
            (*message).to_string()
        } else if let Some(message) = panic_info.payload().downcast_ref::<String>() {
            message.clone()
        } else {
            "unknown panic payload".to_string()
        };
        let location = panic_info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let panic_line = format!(
            "timestamp={} level=ERROR component=desktop.app event=panic location={} payload={}",
            Utc::now().to_rfc3339(),
            quote_value(&location),
            quote_value(&payload)
        );

        append_specific_log_file(&log_file_path, &panic_line);
        eprintln!("{panic_line}");
        previous_hook(panic_info);
    }));
}

fn append_specific_log_file(log_file_path: &Path, line: &str) {
    let write_lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _write_guard = write_lock.lock().expect("log write mutex should not be poisoned");

    if let Some(parent) = log_file_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file_path)
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
        .unwrap_or_else(|| env::temp_dir().join("pharles-dev"))
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
