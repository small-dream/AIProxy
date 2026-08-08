import { describe, expect, it } from "vitest";

import { computeMobilePreflight } from "./mobile-preflight.helpers";

describe("computeMobilePreflight", () => {
  it("is ready when the cert exists, the proxy is running, and a local IP is available", () => {
    expect(
      computeMobilePreflight({ hasCert: true, proxyRunning: true, localIp: "192.168.1.10" }),
    ).toEqual({ ready: true, gaps: [] });
  });

  it("flags a missing generated certificate", () => {
    expect(
      computeMobilePreflight({ hasCert: false, proxyRunning: true, localIp: "192.168.1.10" }),
    ).toEqual({ ready: false, gaps: ["certGenerated"] });
  });

  it("flags a stopped proxy", () => {
    expect(
      computeMobilePreflight({ hasCert: true, proxyRunning: false, localIp: "192.168.1.10" }),
    ).toEqual({ ready: false, gaps: ["proxyRunning"] });
  });

  it("flags a missing local IP", () => {
    expect(
      computeMobilePreflight({ hasCert: true, proxyRunning: true, localIp: undefined }),
    ).toEqual({ ready: false, gaps: ["localIp"] });
  });

  it("treats a null local IP the same as an absent one", () => {
    expect(computeMobilePreflight({ hasCert: true, proxyRunning: true, localIp: null })).toEqual({
      ready: false,
      gaps: ["localIp"],
    });
  });

  it("reports gaps in a stable order when several are missing", () => {
    expect(
      computeMobilePreflight({ hasCert: false, proxyRunning: false, localIp: undefined }),
    ).toEqual({ ready: false, gaps: ["certGenerated", "proxyRunning", "localIp"] });
  });
});
