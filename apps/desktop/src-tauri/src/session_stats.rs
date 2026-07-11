use crate::dev_logger::write_stderr_line;
use chrono::Utc;
use std::{
    env,
    ffi::OsStr,
    fs::{self, File, OpenOptions},
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
/// M17: the stats log file handle, opened once in `initialize` and held open
/// for the process lifetime. Previously `append_to_log_file` did a
/// `create_dir_all`, an `OpenOptions::open`, and a close on every `record()`
/// call, blocking the caller (often an IPC worker) with syscalls per event.
/// The handle is stored in a `Mutex` so writers serialize without a separate
/// lock.
static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();
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

    // M17: open the file once (truncate to reset for this run) and hold the
    // handle in LOG_FILE for the process lifetime. `record()` will append to
    // this handle without reopening per call.
    let file = OpenOptions::new()
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
    let _ = LOG_FILE.set(Mutex::new(file));

    // L13: record the resolved path for observability without round-tripping
    // through env::set_var (which is not thread-safe).
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
    // M17: append to the held file handle (opened once in initialize). No per-call
    // create_dir_all or open. Falls back to the legacy reopen path only if
    // initialize was never called (e.g. stats enabled via env after startup).
    if let Some(cell) = LOG_FILE.get() {
        // LOG_FILE's own Mutex serializes writers; WRITE_LOCK is kept for the
        // fallback path below so the two paths do not race each other.
        if let Ok(mut file) = cell.lock() {
            let _ = writeln!(file, "{line}");
            return;
        }
    }

    // Fallback: initialize was not called (LOG_FILE unset). Reopen per call
    // under the global lock to preserve the pre-M17 behavior.
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
