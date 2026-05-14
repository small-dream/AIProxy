use crate::dev_logger::write_stderr_line;
use chrono::Utc;
use std::{
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};

const SESSION_STATS_ENV_VAR: &str = "AIPROXY_SESSION_STATS";
const SESSION_STATS_FILE_ENV_VAR: &str = "AIPROXY_SESSION_STATS_FILE";
const SESSION_STATS_FILE_NAME: &str = "session-stats.log";

static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SESSION_STATS_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn initialize() -> Result<Option<PathBuf>, String> {
    let explicit_flag = env_flag_state(SESSION_STATS_ENV_VAR);
    let explicit_file_path = env::var(SESSION_STATS_FILE_ENV_VAR)
        .ok()
        .filter(|value| !value.trim().is_empty());
    let enabled =
        explicit_flag.unwrap_or_else(|| explicit_file_path.is_some() || cfg!(debug_assertions));

    SESSION_STATS_ENABLED.store(enabled, Ordering::Relaxed);

    if !enabled {
        return Ok(None);
    }

    let log_file_path = resolve_log_file_path();

    if let Some(parent) = log_file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create session stats log directory {}: {error}",
                parent.display()
            )
        })?;
    }

    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_file_path)
        .map_err(|error| {
            format!(
                "failed to reset session stats log file {}: {error}",
                log_file_path.display()
            )
        })?;

    env::set_var(SESSION_STATS_FILE_ENV_VAR, &log_file_path);

    record(
        "session_stats_initialized",
        &[("stats_file", log_file_path.display().to_string())],
    );

    Ok(Some(log_file_path))
}

pub fn is_enabled() -> bool {
    SESSION_STATS_ENABLED.load(Ordering::Relaxed)
}

pub fn record(event: &str, fields: &[(&str, String)]) {
    if !is_enabled() {
        return;
    }

    let timestamp = Utc::now().to_rfc3339();
    let mut line =
        format!("timestamp={timestamp} level=INFO component=session-stats event={event}");

    for (name, value) in fields {
        line.push(' ');
        line.push_str(name);
        line.push('=');
        line.push_str(&quote_value(value));
    }

    write_stderr_line(&line);
    append_to_log_file(&line);
}

fn append_to_log_file(line: &str) {
    let write_lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _write_guard = write_lock.lock().unwrap_or_else(|error| error.into_inner());

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
    if let Ok(log_file) = env::var(SESSION_STATS_FILE_ENV_VAR) {
        if !log_file.trim().is_empty() {
            return PathBuf::from(log_file);
        }
    }

    discover_workspace_root_from_current_exe()
        .unwrap_or_else(|| env::temp_dir().join("aiproxy-dev"))
        .join("logs")
        .join("dev")
        .join(SESSION_STATS_FILE_NAME)
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

fn env_flag_state(name: &str) -> Option<bool> {
    let value = env::var(name).ok()?;
    let normalized = value.trim().to_ascii_lowercase();

    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn quote_value(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");

    format!("\"{escaped}\"")
}
