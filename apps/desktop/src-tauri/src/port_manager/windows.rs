use std::process::Command;

use aiproxy_sys_util::CommandExt;
use super::{parse_netstat_pid, parse_tasklist_name, PortOccupant};

/// Decodes the stdout of legacy Windows console tools (`netstat`, `tasklist`).
///
/// These tools emit bytes in the system's OEM code page (e.g. 936/GBK on zh-CN
/// Windows), not UTF-8. Decoding that with `String::from_utf8_lossy` turns any
/// non-ASCII image name into mojibake, which then shows up garbled in the
/// port-in-use dialog. We first try UTF-8 (modern systems / ASCII-only output),
/// then fall back to translating through the OEM code page.
fn decode_console_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    use windows_sys::Win32::Globalization::{GetOEMCP, MultiByteToWideChar};

    let code_page = unsafe { GetOEMCP() };
    // Safety: we pass a valid pointer/length for the input and let the API size
    // the output buffer via a two-pass call.
    let wide_len = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        )
    };
    if wide_len <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }

    let mut buffer = vec![0u16; wide_len as usize];
    let written = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            bytes.len() as i32,
            buffer.as_mut_ptr(),
            wide_len,
        )
    };
    if written <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }

    String::from_utf16_lossy(&buffer[..written as usize])
}

/// Resolves the process listening on `port` via `netstat` + `tasklist`. Returns
/// `Ok(None)` when the port is free. The image name falls back to `pid:{pid}`
/// if `tasklist` yields nothing usable, so the UI can still display something.
pub fn find_port_occupant(port: u16) -> Result<Option<PortOccupant>, String> {
    let netstat = Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .no_window()
        .output()
        .map_err(|error| format!("failed to run netstat: {error}"))?;
    let netstat_stdout = decode_console_output(&netstat.stdout);
    let Some(pid) = parse_netstat_pid(&netstat_stdout, port) else {
        return Ok(None);
    };

    let tasklist = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .no_window()
        .output()
        .map_err(|error| format!("failed to run tasklist for pid {pid}: {error}"))?;
    let name = parse_tasklist_name(&decode_console_output(&tasklist.stdout))
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
