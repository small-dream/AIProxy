import { describe, expect, it } from "vitest";

import { colorTokens, radiusTokens, spacingTokens } from "./index";

describe("colorTokens", () => {
  it("defines both light and dark palettes", () => {
    expect(colorTokens.light.primary).toBe("#2563EB");
    expect(colorTokens.dark.surface).toBe("#151B23");
  });
});

describe("spacingTokens", () => {
  it("keeps the 4pt scale for small spacing", () => {
    expect(spacingTokens.xs).toBe(4);
    expect(spacingTokens.sm).toBe(8);
  });
});

describe("radiusTokens", () => {
  it("uses the documented control radius", () => {
    expect(radiusTokens.control).toBe(8);
  });
});

