use std::net::Ipv4Addr;

use aiproxy_sys_util::CommandExt;

pub(super) fn ranked_interface_ipv4_addresses() -> Vec<String> {
    const POWERSHELL_SCRIPT: &str = r#"
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -ne '127.0.0.1' -and
    $_.PrefixOrigin -ne 'WellKnown' -and
    $_.AddressState -eq 'Preferred'
  } |
  Select-Object IPAddress, InterfaceAlias |
  ConvertTo-Json -Compress
"#;

    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            POWERSHELL_SCRIPT,
        ])
        .no_window()
        .output();

    let stdout = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => return Vec::new(),
    };

    let entries = super::parse_interface_json(&stdout);

    let mut scored: Vec<(i32, Ipv4Addr)> = entries
        .into_iter()
        .filter(|(_, ip)| is_usable_ipv4(*ip))
        .map(|(name, ip)| (score_interface_ipv4(&name, ip), ip))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));

    let mut seen = std::collections::HashSet::new();
    scored
        .into_iter()
        .filter_map(|(_, ip)| {
            let s = ip.to_string();
            seen.insert(s.clone()).then_some(s)
        })
        .collect()
}

pub(super) fn is_usable_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified()
}

pub(super) fn score_interface_ipv4(interface_name: &str, ip: Ipv4Addr) -> i32 {
    let octets = ip.octets();
    let mut score = if octets[0] == 192 && octets[1] == 168 {
        500
    } else if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        450
    } else if octets[0] == 10 {
        400
    } else if ip.is_private() {
        350
    } else {
        100
    };

    let lowercase_name = interface_name.to_ascii_lowercase();

    if lowercase_name.starts_with("ethernet")
        || lowercase_name.starts_with("wi-fi")
        || lowercase_name.starts_with("eth")
        || lowercase_name.starts_with("wlan")
    {
        score += 100;
    }

    if lowercase_name.starts_with("vethernet")
        || lowercase_name.starts_with("hyper-v")
        || lowercase_name.starts_with("loopback")
        || lowercase_name.starts_with("tunnel")
        || lowercase_name.starts_with("wsl")
        || lowercase_name.starts_with("docker")
        || lowercase_name.starts_with("veth")
    {
        score -= 250;
    }

    score
}
