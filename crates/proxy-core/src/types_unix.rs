use std::{collections::HashSet, ffi::CStr, net::Ipv4Addr};

pub(super) fn ranked_interface_ipv4_addresses() -> Vec<String> {
    let mut interface_addresses = Vec::new();
    let mut addrs = std::ptr::null_mut();

    // SAFETY: getifaddrs takes a mutable pointer to a linked list head.
    // On failure (result != 0) or null return, we bail early.
    let result = unsafe { libc::getifaddrs(&mut addrs) };
    if result != 0 || addrs.is_null() {
        return Vec::new();
    }

    let mut cursor = addrs;
    while !cursor.is_null() {
        // SAFETY: cursor is non-null and points to a valid ifaddrs node in the
        // linked list returned by getifaddrs. The list is null-terminated.
        let ifaddr = unsafe { &*cursor };

        if !ifaddr.ifa_addr.is_null() {
            // SAFETY: ifa_addr is non-null and was populated by getifaddrs.
            // We only read sa_family, which is always valid for any sockaddr variant.
            let family = unsafe { (*ifaddr.ifa_addr).sa_family as i32 };
            let flags = ifaddr.ifa_flags as i32;

            if family == libc::AF_INET
                && flags & libc::IFF_UP != 0
                && flags & libc::IFF_LOOPBACK == 0
            {
                // SAFETY: ifa_name is a valid C string populated by getifaddrs.
                let interface_name = unsafe { CStr::from_ptr(ifaddr.ifa_name) }
                    .to_string_lossy()
                    .into_owned();
                // SAFETY: We checked sa_family == AF_INET, so ifa_addr points to
                // a valid sockaddr_in. The pointer cast is sound.
                let sockaddr_in = unsafe { &*(ifaddr.ifa_addr as *const libc::sockaddr_in) };
                let ip = Ipv4Addr::from(u32::from_be(sockaddr_in.sin_addr.s_addr));

                if is_usable_ipv4(ip) {
                    interface_addresses.push((score_interface_ipv4(&interface_name, ip), ip));
                }
            }
        }

        cursor = ifaddr.ifa_next;
    }

    // SAFETY: addrs was allocated by getifaddrs and must be freed by freeifaddrs.
    // After this call, the memory is released and must not be accessed again.
    unsafe {
        libc::freeifaddrs(addrs);
    }

    interface_addresses.sort_by(|left, right| right.cmp(left));

    let mut seen = HashSet::new();
    interface_addresses
        .into_iter()
        .filter_map(|(_, ip)| {
            let ip = ip.to_string();
            if seen.insert(ip.clone()) {
                Some(ip)
            } else {
                None
            }
        })
        .collect()
}

pub(super) fn is_usable_ipv4(ip: std::net::Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified()
}

pub(super) fn score_interface_ipv4(interface_name: &str, ip: std::net::Ipv4Addr) -> i32 {
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

    if lowercase_name.starts_with("en")
        || lowercase_name.starts_with("eth")
        || lowercase_name.starts_with("wlan")
        || lowercase_name.starts_with("wifi")
    {
        score += 100;
    }

    if lowercase_name.starts_with("utun")
        || lowercase_name.starts_with("tun")
        || lowercase_name.starts_with("tap")
        || lowercase_name.starts_with("docker")
        || lowercase_name.starts_with("veth")
        || lowercase_name.starts_with("br-")
        || lowercase_name.starts_with("bridge")
        || lowercase_name.starts_with("vmnet")
        || lowercase_name.starts_with("awdl")
        || lowercase_name.starts_with("llw")
    {
        score -= 250;
    }

    score
}
