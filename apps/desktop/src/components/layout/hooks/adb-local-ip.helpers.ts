/**
 * Heuristic pick of the local IP most likely reachable from a phone on the
 * same Wi-Fi network (review low): the ADB quick-menu path used to take
 * `localIps[0]`, which on multi-adapter machines (VPN, virtualization
 * bridges, docker networks) is frequently an address the phone cannot route
 * to — the proxy then "succeeds" while the phone has no connectivity.
 *
 * Excludes loopback, IPv6 link-local and 169.254.* auto-config addresses,
 * then prefers IPv4 private ranges in the OS-reported order. When the
 * filter matches nothing, the FIRST original entry is returned unchanged —
 * the behavior degrades to the previous one rather than failing outright.
 * The full solution remains the certificate center's explicit IP picker.
 */
export function pickPhoneReachableLocalIp(ips: readonly string[]): string | undefined {
  if (ips.length === 0) {
    return undefined;
  }

  const isExcluded = (ip: string): boolean =>
    ip === "::1" || ip.startsWith("127.") || ip.startsWith("169.254.") || ip.startsWith("fe80:");

  const isPrivateIpv4 = (ip: string): boolean => {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return false;
    }
    const [first, second] = ip.split(".").map(Number);
    if (first === undefined || second === undefined) {
      return false;
    }
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  };

  const candidates = ips.filter((ip) => !isExcluded(ip));
  // Among private IPv4s prefer the ranges real Wi-Fi LANs use (192.168.*,
  // then 10.*) over 172.16-31, which docker/WSL bridges occupy — the OS
  // often lists the virtual adapter first.
  const privateIpv4s = candidates.filter((ip) => isPrivateIpv4(ip));
  const preferred =
    privateIpv4s.find((ip) => ip.startsWith("192.168.")) ??
    privateIpv4s.find((ip) => ip.startsWith("10.")) ??
    privateIpv4s[0];
  return preferred ?? candidates[0] ?? ips[0];
}
