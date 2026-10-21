/**
 * Host pattern matching shared by frontend previews and conflict checks.
 *
 * The authoritative runtime matcher lives in Rust (`host_pattern.rs`). Keep
 * the accepted forms aligned: exact hosts, `*.example.com` suffixes, `*`, and
 * CIDR ranges for literal IP targets.
 */

type ParsedIp = {
  family: 4 | 6;
  value: bigint;
};

function normalizeHostToken(value: string): string {
  const trimmed = value.trim();
  const unbracketed =
    trimmed.length >= 2 && trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;

  return unbracketed.replace(/\.+$/, "");
}

function parseIpv4(value: string): bigint | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  let result = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function parseIpv6(value: string): bigint | null {
  let input = value.toLowerCase();
  if (input.includes("%")) return null;

  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(input.slice(lastColon + 1));
    if (ipv4 === null) return null;
    input = `${input.slice(0, lastColon + 1)}${((ipv4 >> 8n) & 0xffffn).toString(16)}:${(
      ipv4 & 0xffffn
    ).toString(16)}`;
  }

  const compressionIndex = input.indexOf("::");
  if (compressionIndex !== input.lastIndexOf("::")) return null;

  const hasCompression = compressionIndex >= 0;
  const leftText = hasCompression ? input.slice(0, compressionIndex) : input;
  const rightText = hasCompression ? input.slice(compressionIndex + 2) : "";
  const left = leftText.length === 0 ? [] : leftText.split(":");
  const right = rightText.length === 0 ? [] : rightText.split(":");
  const groups = [...left, ...right];

  if (
    groups.some((group) => group.length === 0 || group.length > 4 || !/^[0-9a-f]+$/.test(group))
  ) {
    return null;
  }

  const total = groups.length;
  if (hasCompression ? total >= 8 : total !== 8) return null;

  const expanded = [...left, ...Array.from({ length: 8 - total }, () => "0"), ...right];

  let result = 0n;
  for (const group of expanded) {
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

function parseIp(value: string): ParsedIp | null {
  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) return { family: 4, value: ipv4 };

  const ipv6 = parseIpv6(value);
  if (ipv6 !== null) return { family: 6, value: ipv6 };

  return null;
}

function ipInCidr(host: ParsedIp, network: ParsedIp, prefixLength: number): boolean {
  if (host.family !== network.family) return false;

  const width = host.family === 4 ? 32 : 128;
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > width) {
    return false;
  }

  const mask = ((1n << BigInt(prefixLength)) - 1n) << BigInt(width - prefixLength);
  return (host.value & mask) === (network.value & mask);
}

/** Whether a host matches any entry in a host-pattern list. */
export function matchesHostPattern(patterns: readonly string[], host: string): boolean {
  const normalizedHost = normalizeHostToken(host);
  if (normalizedHost.length === 0) return false;

  const hostLower = normalizedHost.toLowerCase();
  const parsedHost = parseIp(normalizedHost);

  return patterns.some((rawPattern) => {
    const pattern = normalizeHostToken(rawPattern);
    if (pattern.length === 0) return false;
    if (pattern === "*") return true;

    const patternLower = pattern.toLowerCase();
    const separator = patternLower.indexOf("/");
    if (separator >= 0) {
      const networkText = patternLower.slice(0, separator);
      const prefixText = patternLower.slice(separator + 1);
      if (prefixText.includes("/") || !/^\d+$/.test(prefixText)) return false;

      const network = parseIp(networkText);
      if (parsedHost === null || network === null) return false;
      return ipInCidr(parsedHost, network, Number(prefixText));
    }

    if (patternLower.startsWith("*.")) {
      const suffix = patternLower.slice(2);
      return hostLower === suffix || hostLower.endsWith(`.${suffix}`);
    }

    if (patternLower.startsWith(".")) {
      const suffix = patternLower.slice(1);
      return hostLower === suffix || hostLower.endsWith(`.${suffix}`);
    }

    return hostLower === patternLower;
  });
}
