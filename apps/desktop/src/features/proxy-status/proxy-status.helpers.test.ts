import { describe, expect, it } from "vitest";
import { createDefaultProxyStatus } from "@pharles/shared-types";

import { getProxyStatusPresentation } from "./proxy-status.helpers";

describe("getProxyStatusPresentation", () => {
  it("returns a loading label when the status is not yet available", () => {
    const actual = getProxyStatusPresentation(undefined);

    expect(actual).toEqual({
      chipColor: "default",
      label: "Proxy Loading",
    });
  });

  it("returns a running label when the proxy is active", () => {
    const actual = getProxyStatusPresentation({
      ...createDefaultProxyStatus(),
      port: 9999,
      running: true,
    });

    expect(actual).toEqual({
      chipColor: "success",
      label: "Proxy Running :9999",
    });
  });
});

