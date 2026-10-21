import { describe, expect, it } from "vitest";

import {
  permissionsEqual,
  permissionsForPreset,
  presetForPermissions,
} from "./agent-access.helpers";

describe("Agent permission presets", () => {
  it("maps each preset to a concrete scope", () => {
    expect(permissionsForPreset("metadata")).toEqual({
      readSessions: true,
      readBodies: false,
      readRawBodies: false,
      readWebSocket: false,
      exportSnapshots: false,
    });
    expect(permissionsForPreset("bodies")).toEqual({
      readSessions: true,
      readBodies: true,
      readRawBodies: false,
      readWebSocket: true,
      exportSnapshots: false,
    });
    expect(permissionsForPreset("raw")).toEqual({
      readSessions: true,
      readBodies: true,
      readRawBodies: true,
      readWebSocket: true,
      exportSnapshots: false,
    });
  });

  it("infers the closest preset from saved permissions", () => {
    expect(presetForPermissions(permissionsForPreset("metadata"))).toBe("metadata");
    expect(presetForPermissions(permissionsForPreset("bodies"))).toBe("bodies");
    expect(presetForPermissions(permissionsForPreset("raw"))).toBe("raw");
    expect(
      presetForPermissions({
        ...permissionsForPreset("metadata"),
        readWebSocket: true,
      }),
    ).toBe("metadata");
  });

  it("compares every permission flag", () => {
    const base = permissionsForPreset("bodies");
    expect(permissionsEqual(base, { ...base })).toBe(true);
    expect(permissionsEqual(base, { ...base, readRawBodies: true })).toBe(false);
    expect(permissionsEqual(base, { ...base, readWebSocket: false })).toBe(false);
    expect(permissionsEqual(base, { ...base, exportSnapshots: true })).toBe(false);
  });
});
