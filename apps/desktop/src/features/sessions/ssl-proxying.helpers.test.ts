import { describe, expect, it } from "vitest";

import type { SslProxyingSettings } from "@aiproxy/shared-types";

import { isHostExcludedBySslProxying } from "./ssl-proxying.helpers";

function settings(overrides: Partial<SslProxyingSettings> = {}): SslProxyingSettings {
  return {
    includeEnabled: false,
    excludeEnabled: true,
    include: [],
    exclude: [{ pattern: "*.googleapis.com", enabled: true }],
    ...overrides,
  };
}

describe("isHostExcludedBySslProxying", () => {
  it("matches enabled Exclude entries", () => {
    expect(isHostExcludedBySslProxying(settings(), "api.googleapis.com")).toBe(true);
  });

  it("ignores disabled entries and a disabled Exclude master switch", () => {
    expect(
      isHostExcludedBySslProxying(
        settings({ exclude: [{ pattern: "*.googleapis.com", enabled: false }] }),
        "api.googleapis.com",
      ),
    ).toBe(false);
    expect(
      isHostExcludedBySslProxying(settings({ excludeEnabled: false }), "api.googleapis.com"),
    ).toBe(false);
  });
});
