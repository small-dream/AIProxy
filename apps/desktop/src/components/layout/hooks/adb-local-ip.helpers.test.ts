import { describe, expect, it } from "vitest";

import { pickPhoneReachableLocalIp } from "./adb-local-ip.helpers";

describe("pickPhoneReachableLocalIp", () => {
  it("prefers a 192.168.* LAN address over a 172.20.* docker/VPN adapter that happens to be first", () => {
    expect(pickPhoneReachableLocalIp(["172.20.0.2", "192.168.1.42"])).toBe("192.168.1.42");
  });

  it("falls back to 10.* before the 172.16-31 ranges", () => {
    expect(pickPhoneReachableLocalIp(["172.20.0.2", "10.1.2.3"])).toBe("10.1.2.3");
  });

  it("keeps the first private IPv4 when several share the preferred range (OS order wins)", () => {
    expect(pickPhoneReachableLocalIp(["192.168.1.5", "192.168.0.7"])).toBe("192.168.1.5");
  });

  it("excludes loopback, link-local and IPv6 link-local addresses", () => {
    expect(pickPhoneReachableLocalIp(["127.0.0.1", "169.254.5.6", "fe80::1", "10.1.2.3"])).toBe(
      "10.1.2.3",
    );
  });

  it("falls back to the first non-excluded address when no private IPv4 exists", () => {
    expect(pickPhoneReachableLocalIp(["100.64.1.9", "fd00::2"])).toBe("100.64.1.9");
  });

  it("degrades to the original first entry when everything is excluded", () => {
    expect(pickPhoneReachableLocalIp(["127.0.0.1"])).toBe("127.0.0.1");
  });

  it("returns undefined for an empty list", () => {
    expect(pickPhoneReachableLocalIp([])).toBeUndefined();
  });
});
