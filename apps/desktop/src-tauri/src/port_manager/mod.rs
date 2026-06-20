use serde::Serialize;

/// The process currently holding a TCP port. Drives the "end the occupying
/// process and restart the proxy on the same port" recovery flow shown in the
/// port-change dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOccupant {
    pub pid: u32,
    pub name: String,
}

// --- Parsers (pure, compiled on every platform so they stay unit-tested) ---

/// Parses `lsof -nP -iTCP:{port} -sTCP:LISTEN` stdout into the first occupant.
/// Example row:
///   COMMAND   PID  USER   FD   TYPE  DEVICE  SIZE/OFF  NODE NAME
///   node     48213 jake  23u  IPv4  0x..   0t0        TCP  *:8888 (LISTEN)
fn parse_lsof_occupant(stdout: &str) -> Option<PortOccupant> {
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else {
            continue;
        };
        let Some(pid_str) = parts.next() else {
            continue;
        };
        // Header rows and non-listening noise have a non-numeric PID column.
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if pid == 0 {
            continue;
        }
        return Some(PortOccupant {
            pid,
            name: name.to_string(),
        });
    }
    None
}

/// Parses `netstat -ano -p TCP` stdout and returns the PID listening on `port`.
/// Example rows:
///   TCP    0.0.0.0:8888      0.0.0.0:0         LISTENING   48213
///   TCP    [::]:8888         [::]:0            LISTENING   48213
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_netstat_pid(stdout: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    for line in stdout.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // Expect at least: PROTO LOCAL FOREIGN STATE PID
        if tokens.len() < 5 {
            continue;
        }
        let local_addr = tokens[1];
        let state = tokens[tokens.len() - 2];
        let pid_str = tokens[tokens.len() - 1];
        if state != "LISTENING" || !local_addr.ends_with(&suffix) {
            continue;
        }
        if let Ok(pid) = pid_str.parse::<u32>() {
            // PID 0 = System Idle; PID 4 = Windows "System" — neither is a safe
            // kill target, so never surface them as the occupant.
            if pid != 0 && pid != 4 {
                return Some(pid);
            }
        }
    }
    None
}

/// Parses `tasklist /FI "PID eq x" /FO CSV /NH` stdout into the image name.
/// Example: "node.exe","48213","Console","1","123,456 K"
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_tasklist_name(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?;
    let first = line.split(',').next()?;
    let trimmed = first.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

/// Whether a resolved occupant still matches a kill request (same pid, and the
/// same name when one was provided). Drives the TOCTOU re-check before kill so
/// a recycled PID can't be misfired onto an unrelated process.
pub fn occupant_matches(current: Option<&PortOccupant>, pid: u32, name: Option<&str>) -> bool {
    match current {
        Some(occupant) => occupant.pid == pid && name.is_none_or(|n| n == occupant.name),
        None => false,
    }
}

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::{find_port_occupant, kill_process_by_pid};
#[cfg(windows)]
pub use windows::{find_port_occupant, kill_process_by_pid};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lsof_occupant_from_first_data_row() {
        let stdout = "COMMAND   PID  USER   FD   TYPE  DEVICE  SIZE/OFF  NODE NAME\n\
                      node     48213 jake  23u  IPv4  0x1   0t0        TCP  *:8888 (LISTEN)\n";
        let occupant = parse_lsof_occupant(stdout).expect("occupant");
        assert_eq!(occupant.pid, 48213);
        assert_eq!(occupant.name, "node");
    }

    #[test]
    fn parses_lsof_occupant_skips_header_row() {
        // Header row's PID column is "PID" (non-numeric) and must be skipped.
        let stdout = "COMMAND   PID  USER   FD   TYPE  DEVICE  SIZE/OFF  NODE NAME\n\
                      python3  1234  jake  3u  IPv4  0x2   0t0       TCP  *:8888 (LISTEN)\n";
        let occupant = parse_lsof_occupant(stdout).expect("occupant");
        assert_eq!(occupant.pid, 1234);
        assert_eq!(occupant.name, "python3");
    }

    #[test]
    fn parse_lsof_returns_none_for_empty_output() {
        assert!(parse_lsof_occupant("").is_none());
        assert!(parse_lsof_occupant("COMMAND PID USER\n").is_none());
    }

    #[test]
    fn parses_netstat_pid_for_ipv4_and_ipv6_listening_rows() {
        let stdout = "  TCP   0.0.0.0:8888      0.0.0.0:0    LISTENING   48213\n\
                       TCP   [::]:8888         [::]:0       LISTENING   48214\n\
                       TCP   0.0.0.0:9999      0.0.0.0:0    LISTENING   7\n";
        assert_eq!(parse_netstat_pid(stdout, 8888), Some(48213));
    }

    #[test]
    fn parse_netstat_ignores_non_listening_and_other_ports() {
        let stdout = "  TCP   0.0.0.0:8888      0.0.0.0:0    ESTABLISHED 48213\n\
                       TCP   0.0.0.0:9999      0.0.0.0:0    LISTENING   5\n";
        assert!(parse_netstat_pid(stdout, 8888).is_none());
    }

    #[test]
    fn parse_tasklist_strips_quotes_and_returns_image_name() {
        let stdout = "\"node.exe\",\"48213\",\"Console\",\"1\",\"123,456 K\"\n";
        assert_eq!(parse_tasklist_name(stdout).as_deref(), Some("node.exe"));
    }

    #[test]
    fn parse_tasklist_returns_none_for_empty_output() {
        assert!(parse_tasklist_name("").is_none());
        assert!(parse_tasklist_name("\"\"").is_none());
    }

    #[test]
    fn parse_netstat_skips_windows_system_pid_4() {
        let stdout = "  TCP   0.0.0.0:8888      0.0.0.0:0    LISTENING   4\n";
        assert!(parse_netstat_pid(stdout, 8888).is_none());
    }

    #[test]
    fn occupant_matches_requires_same_pid() {
        let occupant = PortOccupant {
            pid: 100,
            name: "node".to_string(),
        };
        assert!(occupant_matches(Some(&occupant), 100, None));
        assert!(!occupant_matches(Some(&occupant), 101, None));
    }

    #[test]
    fn occupant_matches_checks_name_when_provided() {
        let occupant = PortOccupant {
            pid: 100,
            name: "node".to_string(),
        };
        assert!(occupant_matches(Some(&occupant), 100, Some("node")));
        // Name mismatch must refuse even when pid matches.
        assert!(!occupant_matches(Some(&occupant), 100, Some("python3")));
    }

    #[test]
    fn occupant_matches_rejects_missing_occupant() {
        assert!(!occupant_matches(None, 100, None));
    }
}
