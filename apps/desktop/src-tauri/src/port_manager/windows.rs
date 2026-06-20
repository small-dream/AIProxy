use std::process::Command;

use aiproxy_sys_util::CommandExt;
use super::{parse_netstat_pid, parse_tasklist_name, PortOccupant};

/// Resolves the process listening on `port` via `netstat` + `tasklist`. Returns
/// `Ok(None)` when the port is free. The image name falls back to `pid:{pid}`
/// if `tasklist` yields nothing usable, so the UI can still display something.
pub fn find_port_occupant(port: u16) -> Result<Option<PortOccupant>, String> {
    let netstat = Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .no_window()
        .output()
        .map_err(|error| format!("failed to run netstat: {error}"))?;
    let netstat_stdout = String::from_utf8_lossy(&netstat.stdout);
    let Some(pid) = parse_netstat_pid(&netstat_stdout, port) else {
        return Ok(None);
    };

    let tasklist = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .no_window()
        .output()
        .map_err(|error| format!("failed to run tasklist for pid {pid}: {error}"))?;
    let name = parse_tasklist_name(&String::from_utf8_lossy(&tasklist.stdout))
        .unwrap_or_else(|| format!("pid:{pid}"));

    Ok(Some(PortOccupant { pid, name }))
}

/// Forcefully terminates the process via `taskkill /F`. The caller re-verifies
/// the PID still owns the port before calling (see `kill_proxy_port_process`).
pub fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .no_window()
        .status()
        .map_err(|error| format!("failed to run taskkill for pid {pid}: {error}"))?;

    if status.success() {
        return Ok(());
    }

    Err(format!("taskkill /PID {pid} /F exited with {status}"))
}
