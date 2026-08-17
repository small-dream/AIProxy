// Multi-adapter machines (VPN, virtualization bridges, docker networks) often
// rank an unreachable address first, which used to hard-code the phone setup
// (QR code + proxy address) to the wrong IP. The UI lets the user pick from
// the detected list; this pure helper keeps the pick valid as the list loads
// or changes underneath.
export function resolveSelectedLocalIp(
  ips: readonly string[] | undefined,
  selected: string | null,
): string | null {
  if (!ips || ips.length === 0) {
    return null;
  }
  // Keep an explicit selection while it still exists in the list; a vanished
  // address (VPN dropped) falls back to the first detected one.
  if (selected && ips.includes(selected)) {
    return selected;
  }
  return ips[0] ?? null;
}
