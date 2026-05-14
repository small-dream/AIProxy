use crate::dev_logger::{log_info, log_warn};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    async_runtime::JoinHandle, Monitor, PhysicalPosition, PhysicalSize, Position, Size,
    WebviewWindow, WindowEvent,
};

const WINDOW_STATE_FILE_NAME: &str = "window-state.json";
const WINDOW_STATE_SAVE_DEBOUNCE_MS: u64 = 250;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedWindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    is_maximized: bool,
}

pub fn restore_main_window_state(window: &WebviewWindow) {
    let Some(state) = load_window_state() else {
        return;
    };

    let normalized_state = normalize_window_state(window, state);
    apply_window_state(window, &normalized_state);

    log_info(
        "desktop.window_state",
        "window_state_restored",
        &[
            ("width", normalized_state.width.to_string()),
            ("height", normalized_state.height.to_string()),
            ("x", normalized_state.x.to_string()),
            ("y", normalized_state.y.to_string()),
            ("is_maximized", normalized_state.is_maximized.to_string()),
        ],
    );
}

pub fn schedule_main_window_state_restore(window: &WebviewWindow) {
    let restore_window = window.clone();

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        restore_main_window_state(&restore_window);
    });
}

pub fn register_main_window_state_tracking(window: &WebviewWindow) {
    let tracked_window = window.clone();
    let pending_save = Arc::new(Mutex::new(None::<JoinHandle<()>>));
    let pending_save_for_events = Arc::clone(&pending_save);

    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            schedule_debounced_persist(
                tracked_window.clone(),
                Arc::clone(&pending_save_for_events),
            );
            return;
        }

        if matches!(
            event,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            cancel_pending_save(&pending_save_for_events);
            persist_main_window_state(&tracked_window);
        }
    });
}

fn normalize_window_state(
    window: &WebviewWindow,
    state: PersistedWindowState,
) -> PersistedWindowState {
    if state.is_maximized {
        return state;
    }

    let Some(target_monitor) = resolve_target_monitor(window, &state) else {
        return state;
    };
    let saved_state_is_visible = is_window_visible_in_monitor(&state, &target_monitor);
    let work_area = target_monitor.work_area();
    let work_left = work_area.position.x;
    let work_top = work_area.position.y;
    let work_width = work_area.size.width.max(1);
    let work_height = work_area.size.height.max(1);
    let clamped_width = state.width.min(work_width);
    let clamped_height = state.height.min(work_height);
    let positioned_state = PersistedWindowState {
        width: clamped_width,
        height: clamped_height,
        x: clamp_i32(
            state.x,
            work_left,
            work_left + work_width.saturating_sub(clamped_width) as i32,
        ),
        y: clamp_i32(
            state.y,
            work_top,
            work_top + work_height.saturating_sub(clamped_height) as i32,
        ),
        is_maximized: false,
    };

    if saved_state_is_visible {
        return positioned_state;
    }

    let centered_state = PersistedWindowState {
        x: work_left + ((work_width.saturating_sub(clamped_width)) / 2) as i32,
        y: work_top + ((work_height.saturating_sub(clamped_height)) / 2) as i32,
        ..positioned_state
    };

    log_info(
        "desktop.window_state",
        "window_state_repositioned_to_visible_area",
        &[
            ("x", centered_state.x.to_string()),
            ("y", centered_state.y.to_string()),
            ("width", centered_state.width.to_string()),
            ("height", centered_state.height.to_string()),
            (
                "monitor",
                target_monitor
                    .name()
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string()),
            ),
        ],
    );

    centered_state
}

fn apply_window_state(window: &WebviewWindow, state: &PersistedWindowState) {
    if !state.is_maximized {
        if let Err(error) =
            window.set_size(Size::Physical(PhysicalSize::new(state.width, state.height)))
        {
            log_warn(
                "desktop.window_state",
                "restore_window_size_failed",
                &[("error", error.to_string())],
            );
        }

        if let Err(error) =
            window.set_position(Position::Physical(PhysicalPosition::new(state.x, state.y)))
        {
            log_warn(
                "desktop.window_state",
                "restore_window_position_failed",
                &[("error", error.to_string())],
            );
        }

        return;
    }

    if let Err(error) = window.maximize() {
        log_warn(
            "desktop.window_state",
            "restore_window_maximized_failed",
            &[("error", error.to_string())],
        );
    }
}

fn resolve_target_monitor(window: &WebviewWindow, state: &PersistedWindowState) -> Option<Monitor> {
    let monitors = match window.available_monitors() {
        Ok(monitors) => monitors,
        Err(error) => {
            log_warn(
                "desktop.window_state",
                "window_monitor_query_failed",
                &[("error", error.to_string())],
            );
            return None;
        }
    };

    if monitors.is_empty() {
        return None;
    }

    if let Some(monitor) = monitors
        .iter()
        .find(|monitor| is_window_visible_in_monitor(state, monitor))
        .cloned()
    {
        return Some(monitor);
    }

    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned())
}

fn is_window_visible_in_monitor(state: &PersistedWindowState, monitor: &Monitor) -> bool {
    let work_area = monitor.work_area();
    let work_left = i64::from(work_area.position.x);
    let work_top = i64::from(work_area.position.y);
    let work_right = work_left + i64::from(work_area.size.width);
    let work_bottom = work_top + i64::from(work_area.size.height);
    let window_left = i64::from(state.x);
    let window_top = i64::from(state.y);
    let window_right = window_left + i64::from(state.width);
    let window_bottom = window_top + i64::from(state.height);
    let overlap_width = (window_right.min(work_right) - window_left.max(work_left)).max(0);
    let overlap_height = (window_bottom.min(work_bottom) - window_top.max(work_top)).max(0);

    overlap_width > 0 && overlap_height > 0
}

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    value.clamp(min.min(max), min.max(max))
}

fn schedule_debounced_persist(
    window: WebviewWindow,
    pending_save: Arc<Mutex<Option<JoinHandle<()>>>>,
) {
    cancel_pending_save(&pending_save);

    let save_task = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(WINDOW_STATE_SAVE_DEBOUNCE_MS)).await;
        persist_main_window_state(&window);
    });

    if let Ok(mut pending_task) = pending_save.lock() {
        *pending_task = Some(save_task);
    }
}

fn cancel_pending_save(pending_save: &Arc<Mutex<Option<JoinHandle<()>>>>) {
    if let Ok(mut pending_task) = pending_save.lock() {
        if let Some(task) = pending_task.take() {
            task.abort();
        }
    }
}

pub fn persist_main_window_state(window: &WebviewWindow) {
    match capture_window_state(window) {
        Ok(state) => {
            if let Err(error) = save_window_state(&state) {
                log_warn(
                    "desktop.window_state",
                    "persist_window_state_failed",
                    &[("error", error)],
                );
                return;
            }

            log_info(
                "desktop.window_state",
                "window_state_persisted",
                &[
                    ("width", state.width.to_string()),
                    ("height", state.height.to_string()),
                    ("x", state.x.to_string()),
                    ("y", state.y.to_string()),
                    ("is_maximized", state.is_maximized.to_string()),
                ],
            );
        }
        Err(error) => {
            log_warn(
                "desktop.window_state",
                "capture_window_state_failed",
                &[("error", error)],
            );
        }
    }
}

fn capture_window_state(window: &WebviewWindow) -> Result<PersistedWindowState, String> {
    let size = window
        .inner_size()
        .map_err(|error| format!("failed to read window size: {error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("failed to read window position: {error}"))?;
    let is_maximized = window
        .is_maximized()
        .map_err(|error| format!("failed to read maximized state: {error}"))?;

    Ok(PersistedWindowState {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        is_maximized,
    })
}

fn load_window_state() -> Option<PersistedWindowState> {
    let file_path = resolve_window_state_path();
    let contents = match fs::read_to_string(&file_path) {
        Ok(contents) => contents,
        Err(_) => return None,
    };

    match serde_json::from_str::<PersistedWindowState>(&contents) {
        Ok(state) => Some(state),
        Err(error) => {
            log_warn(
                "desktop.window_state",
                "window_state_parse_failed",
                &[
                    ("path", file_path.display().to_string()),
                    ("error", error.to_string()),
                ],
            );
            None
        }
    }
}

fn save_window_state(state: &PersistedWindowState) -> Result<(), String> {
    let file_path = resolve_window_state_path();

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create window state directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let json = serde_json::to_string_pretty(state)
        .map_err(|error| format!("failed to serialize window state: {error}"))?;

    fs::write(&file_path, json).map_err(|error| {
        format!(
            "failed to write window state file {}: {error}",
            file_path.display()
        )
    })
}

fn resolve_window_state_path() -> PathBuf {
    aiproxy_db::connection::resolve_db_dir()
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .or_else(dirs::data_local_dir)
                .unwrap_or_else(std::env::temp_dir)
        })
        .join(WINDOW_STATE_FILE_NAME)
}
