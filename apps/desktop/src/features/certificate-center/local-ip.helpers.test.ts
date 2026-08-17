import { describe, expect, it } from "vitest";

import { resolveSelectedLocalIp } from "./local-ip.helpers";

describe("resolveSelectedLocalIp", () => {
  it("returns null when no addresses are detected yet", () => {
    expect(resolveSelectedLocalIp(undefined, null)).toBeNull();
    expect(resolveSelectedLocalIp([], null)).toBeNull();
  });

  it("defaults to the first detected address", () => {
    expect(resolveSelectedLocalIp(["192.168.1.10", "10.0.0.5"], null)).toBe("192.168.1.10");
  });

  it("keeps an explicit selection that still exists in the list", () => {
    expect(resolveSelectedLocalIp(["192.168.1.10", "10.0.0.5"], "10.0.0.5")).toBe("10.0.0.5");
  });

  it("falls back to the first address when the selection vanished (e.g. VPN dropped)", () => {
    expect(resolveSelectedLocalIp(["192.168.1.10"], "172.17.0.1")).toBe("192.168.1.10");
  });
});
