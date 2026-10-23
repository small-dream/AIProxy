import { describe, expect, it } from "vitest";

import { navigationItems } from "./navigation-items";

describe("navigationItems", () => {
  it("keeps user guides out of the primary activity bar", () => {
    expect(navigationItems.some((item) => item.to === "/docs")).toBe(false);
  });
});
