use std::{
    env,
    ffi::OsStr,
    fs,
    io::Write,
    panic::{self, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use chrono::Utc;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{fmt::writer::MakeWriterExt, EnvFilter};

const DEV_LOG_ENV_VAR: &str = "AIPROXY_DEV_LOG_FILE";
const DEV_LOG_FILE_NAME: &str = "aiproxy-desktop-dev.log";
const RELEASE_LOG_FILE_NAME: &str = "aiproxy-desktop.log";
const RETAINED_LOG_FILE_COUNT: usize = 15;

static GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

pub fn initialize() -> Result<PathBuf, String> {
    let log_file_base_path = resolve_log_file_base_path();
    let current_log_file_path = current_rolling_log_file_path(&log_file_base_path);

    if let Some(parent) = log_file_base_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create AIProxy development log directory {}: {error}",
                parent.display()
            )
        })?;
    }

    env::set_var(DEV_LOG_ENV_VAR, &log_file_base_path);

    let file_appender = build_file_appender(&log_file_base_path)?;
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _ = GUARD.set(guard);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(non_blocking.and(std::io::stderr))
        .with_ansi(false)
        .init();

    install_panic_hook();

    tracing::info!(
        component = "desktop.app",
        event = "logger_initialized",
        log_file = %current_log_file_path.display(),
        log_file_retention_count = RETAINED_LOG_FILE_COUNT,
        "logger_initialized"
    );

    Ok(current_log_file_path)
}

pub fn current_log_file_path() -> PathBuf {
    current_rolling_log_file_path(&resolve_log_file_base_path())
}

pub fn write_stderr_line(line: &str) {
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{line}");
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

fn build_file_appender(log_file_base_path: &Path) -> Result<RollingFileAppender, String> {
    let directory = log_file_base_path
        .parent()
        .unwrap_or_else(|| Path::new("."));
    let (filename_prefix, filename_suffix) = rolling_filename_parts(log_file_base_path);

    RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(filename_prefix)
        .filename_suffix(filename_suffix)
        .max_log_files(RETAINED_LOG_FILE_COUNT)
        .build(directory)
        .map_err(|error| {
            format!(
                "failed to initialize AIProxy rolling log file appender in {}: {error}",
                directory.display()
            )
        })
}

fn current_rolling_log_file_path(log_file_base_path: &Path) -> PathBuf {
    let directory = log_file_base_path
        .parent()
        .unwrap_or_else(|| Path::new("."));
    let (filename_prefix, filename_suffix) = rolling_filename_parts(log_file_base_path);
    let date = Utc::now().format("%Y-%m-%d");

    let filename = if filename_suffix.is_empty() {
        format!("{filename_prefix}.{date}")
    } else {
        format!("{filename_prefix}.{date}.{filename_suffix}")
    };

    directory.join(filename)
}

fn rolling_filename_parts(log_file_base_path: &Path) -> (String, String) {
    let filename = log_file_base_path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new(DEV_LOG_FILE_NAME));
    let filename_path = Path::new(filename);

    let prefix = filename_path
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEV_LOG_FILE_NAME)
        .to_string();
    let suffix = filename_path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_string();

    (prefix, suffix)
}

fn resolve_log_file_base_path() -> PathBuf {
    if let Ok(log_file) = env::var(DEV_LOG_ENV_VAR) {
        if !log_file.trim().is_empty() {
            return PathBuf::from(log_file);
        }
    }

    if let Some(workspace_root) = discover_workspace_root_from_current_exe() {
        return workspace_root
            .join("logs")
            .join("dev")
            .join(DEV_LOG_FILE_NAME);
    }

    dirs::data_local_dir()
        .unwrap_or_else(|| env::temp_dir().join("aiproxy"))
        .join("AIProxy")
        .join("logs")
        .join(RELEASE_LOG_FILE_NAME)
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
