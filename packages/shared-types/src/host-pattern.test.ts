import { describe, expect, it } from "vitest";

import { matchesHostPattern } from "./host-pattern";

describe("matchesHostPattern", () => {
  it("matches exact hosts case-insensitively and ignores a trailing dot", () => {
    expect(matchesHostPattern(["API.example.com"], "api.example.com.")).toBe(true);
    expect(matchesHostPattern(["api.example.com"], "other.example.com")).toBe(false);
  });

  it("matches suffix patterns including the apex", () => {
    expect(matchesHostPattern(["*.example.com"], "example.com")).toBe(true);
    expect(matchesHostPattern(["*.example.com"], "api.example.com")).toBe(true);
    expect(matchesHostPattern(["*.example.com"], "badexample.com")).toBe(false);
    expect(matchesHostPattern([".example.com"], "api.example.com")).toBe(true);
  });

  it("matches bracketed IPv6 literals and CIDR ranges", () => {
    expect(matchesHostPattern(["2001:db8::5"], "[2001:db8::5]")).toBe(true);
    expect(matchesHostPattern(["192.168.0.0/16"], "192.168.42.7")).toBe(true);
    expect(matchesHostPattern(["192.168.0.0/16"], "192.169.42.7")).toBe(false);
    expect(matchesHostPattern(["fd00::/8"], "[fd12::1]")).toBe(true);
    expect(matchesHostPattern(["fd00::/8"], "[fe80::1]")).toBe(false);
  });

  it("does not resolve hostnames to match IP ranges", () => {
    expect(matchesHostPattern(["127.0.0.0/8"], "localhost")).toBe(false);
  });
});
