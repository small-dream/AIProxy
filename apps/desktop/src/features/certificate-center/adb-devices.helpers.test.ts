import { describe, expect, it } from "vitest";

import { formatAdbDeviceLabel } from "./adb-devices.helpers";

describe("formatAdbDeviceLabel", () => {
  it("prefers the model as the primary label", () => {
    expect(
      formatAdbDeviceLabel({
        serial: "R58M2",
        state: "device",
        model: "Pixel 8",
        product: "shiba",
      }),
    ).toBe("Pixel 8 (R58M2) - device");
  });

  it("falls back to product when model is missing", () => {
    expect(
      formatAdbDeviceLabel({
        serial: "emulator-5554",
        state: "device",
        product: "sdk_gphone64_x86_64",
      }),
    ).toBe("sdk_gphone64_x86_64 (emulator-5554) - device");
  });

  it("falls back to serial when no friendly identifiers exist", () => {
    expect(formatAdbDeviceLabel({ serial: "0123456789ABCDEF", state: "offline" })).toBe(
      "0123456789ABCDEF (0123456789ABCDEF) - offline",
    );
  });
});
