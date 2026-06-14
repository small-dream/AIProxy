// Ordered prerequisites for capturing traffic from a phone/emulator. Note this
// is about MOBILE readiness, which is distinct from the desktop captureReady:
// the phone trusts its own copy of the certificate, so the desktop's trust state
// is not a gate here. What mobile capture needs is a cert to download, a running
// proxy to serve it and intercept traffic, and a reachable local IP.
export type MobilePreflightGap = "certGenerated" | "proxyRunning" | "localIp";

export type MobilePreflightInput = {
  hasCert: boolean;
  proxyRunning: boolean;
  localIp: string | null | undefined;
};

export type MobilePreflight = {
  ready: boolean;
  gaps: MobilePreflightGap[];
};

export function computeMobilePreflight(input: MobilePreflightInput): MobilePreflight {
  const gaps: MobilePreflightGap[] = [];

  if (!input.hasCert) {
    gaps.push("certGenerated");
  }

  if (!input.proxyRunning) {
    gaps.push("proxyRunning");
  }

  if (!input.localIp) {
    gaps.push("localIp");
  }

  return { ready: gaps.length === 0, gaps };
}
