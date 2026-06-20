use std::process::Command;

use super::{parse_lsof_occupant, PortOccupant};

/// Resolves the process listening on `port` via `lsof`. Returns `Ok(None)` when
/// the port is free or `lsof` is unavailable (e.g. a minimal Linux image without
/// lsof installed — logged as a warning so the absence is diagnosable).
pub fn find_port_occupant(port: u16) -> Result<Option<PortOccupant>, String> {
    match Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
        .output()
    {
        Ok(output) => {
            let occupant = parse_lsof_occupant(&String::from_utf8_lossy(&output.stdout));
            if occupant.is_some() {
                return Ok(occupant);
            }
            // Empty stdout normally means "no listener on this port" (lsof exits
            // 1). A non-zero exit with stderr signals a real problem (bad args,
            // permissions); warn so the silent None stays diagnosable.
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !stderr.is_empty() {
                tracing::warn!(
                    component = "desktop.port_manager",
                    event = "lsof_reported_error",
                    port = %port,
                    exit = ?output.status.code(),
                    stderr = %stderr,
                    "lsof reported an error while resolving the port occupant"
                );
            }
            Ok(None)
        }
        Err(error) => {
            tracing::warn!(
                component = "desktop.port_manager",
                event = "lsof_unavailable",
                error = %error,
                "lsof unavailable; cannot resolve port occupant"
            );
            Ok(None)
        }
    }
}

/// Forcefully terminates the process via `kill -9`. The caller is responsible
/// for re-verifying the PID still owns the port before calling (see the
/// `kill_proxy_port_process` command) to avoid PID-reuse misfires.
pub fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .status()
        .map_err(|error| format!("failed to run kill for pid {pid}: {error}"))?;

    if status.success() {
        return Ok(());
    }

    Err(format!("kill -9 {pid} exited with {status}"))
}
