use std::{
    env,
    ffi::OsStr,
    fs,
    io::Write,
    panic::{self, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use tracing_subscriber::{fmt::writer::MakeWriterExt, EnvFilter};

const DEV_LOG_ENV_VAR: &str = "AIPROXY_DEV_LOG_FILE";
const DEV_LOG_FILE_NAME: &str = "aiproxy-desktop-dev.log";

static GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

pub fn initialize() -> Result<PathBuf, String> {
    let log_file_path = resolve_log_file_path();

    if let Some(parent) = log_file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create AIProxy development log directory {}: {error}",
                parent.display()
            )
        })?;
    }

    env::set_var(DEV_LOG_ENV_VAR, &log_file_path);

    let file_appender = tracing_appender::rolling::never(
        log_file_path.parent().unwrap_or_else(|| Path::new(".")),
        log_file_path
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new(DEV_LOG_FILE_NAME)),
    );
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _ = GUARD.set(guard);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(non_blocking.and(std::io::stderr))
        .with_ansi(false)
        .init();

    install_panic_hook();

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

pub fn write_stderr_line(line: &str) {
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{line}");
}

fn emit_log(level: &str, component: &str, event: &str, fields: &[(&str, String)]) {
    let fields_ref: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
    match level {
        "ERROR" => tracing::error!(component, event, fields = ?fields_ref),
        "WARN" => tracing::warn!(component, event, fields = ?fields_ref),
        "INFO" => tracing::info!(component, event, fields = ?fields_ref),
        _ => tracing::debug!(component, event, fields = ?fields_ref),
    }
}

fn install_panic_hook() {
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
            .map(|loc| format!("{}:{}", loc.file(), loc.line()))
            .unwrap_or_else(|| "unknown".to_string());

        tracing::error!(
            component = "desktop.app",
            event = "panic",
            location = %location,
            payload = %payload,
        );

        let _ = panic::catch_unwind(AssertUnwindSafe(|| previous_hook(panic_info)));
    }));
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
