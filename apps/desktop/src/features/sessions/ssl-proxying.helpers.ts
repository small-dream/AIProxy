import { matchesHostPattern, type SslProxyingSettings } from "@aiproxy/shared-types";

/** Whether the active Exclude list prevents this host from being decrypted. */
export function isHostExcludedBySslProxying(settings: SslProxyingSettings, host: string): boolean {
  if (!settings.excludeEnabled) return false;

  const patterns = settings.exclude.filter((entry) => entry.enabled).map((entry) => entry.pattern);
  return matchesHostPattern(patterns, host);
}
