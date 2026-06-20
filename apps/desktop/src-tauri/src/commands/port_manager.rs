use super::common::*;
use crate::port_manager::{find_port_occupant, kill_process_by_pid, occupant_matches, PortOccupant};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillPortProcessInput {
    pub port: u16,
    pub pid: u32,
    pub name: Option<String>,
}

/// Returns the process currently listening on `port`, or `None` if the port is
/// free / the occupant cannot be determined (e.g. missing `lsof` on Linux).
#[tauri::command]
pub async fn get_port_occupant(port: u16) -> Result<Option<PortOccupant>, String> {
    tracing::info!(
        component = "desktop.port_manager",
        event = "get_port_occupant",
        port = %port,
        "get_port_occupant"
    );
    run_blocking_command("get_port_occupant", move || find_port_occupant(port)).await
}

/// Ends the process holding the proxy port so the proxy can restart on it.
///
/// `pid`-only kills are a TOCTOU hazard: between the user confirming and the
/// kill landing, the original process may exit and the PID can be recycled onto
/// an unrelated process. The command therefore re-checks the port's current
/// occupant and only proceeds when `pid` (and `name`, when provided) still
/// match — otherwise it refuses with `PROCESS_CHANGED`.
#[tauri::command]
pub async fn kill_proxy_port_process(input: KillPortProcessInput) -> Result<(), String> {
    if input.pid == 0 {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "Refused to terminate a reserved process (PID 0).",
        ));
    }

    #[cfg(windows)]
    if input.pid == 4 {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "Refused to terminate the Windows System process (PID 4).",
        ));
    }

    run_blocking_command("kill_proxy_port_process", move || {
        match find_port_occupant(input.port)?.as_ref() {
            Some(occupant)
                if occupant_matches(Some(occupant), input.pid, input.name.as_deref()) =>
            {
                tracing::warn!(
                    component = "desktop.port_manager",
                    event = "kill_proxy_port_process",
                    port = %input.port,
                    pid = %input.pid,
                    name = %occupant.name,
                    "kill_proxy_port_process"
                );
                kill_process_by_pid(input.pid)
            }
            _ => Err(app_error(
                ERR_PROCESS_CHANGED,
                "The process holding the port has changed. Refresh and try again.",
            )),
        }
    })
    .await
}
