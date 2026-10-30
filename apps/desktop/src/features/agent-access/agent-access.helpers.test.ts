import { describe, expect, it } from "vitest";

import {
  permissionsForConnectPreset,
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
      controlCapture: false,
      controlSystemProxy: false,
      manageCertificates: false,
      deleteSessions: false,
      sendRequests: false,
      manageRules: false,
    });
    expect(permissionsForPreset("bodies")).toEqual({
      readSessions: true,
      readBodies: true,
      readRawBodies: false,
      readWebSocket: true,
      exportSnapshots: false,
      controlCapture: false,
      controlSystemProxy: false,
      manageCertificates: false,
      deleteSessions: false,
      sendRequests: false,
      manageRules: false,
    });
    expect(permissionsForPreset("raw")).toEqual({
      readSessions: true,
      readBodies: true,
      readRawBodies: true,
      readWebSocket: true,
      exportSnapshots: false,
      controlCapture: false,
      controlSystemProxy: false,
      manageCertificates: false,
      deleteSessions: false,
      sendRequests: false,
      manageRules: false,
    });
    expect(permissionsForPreset("full")).toEqual({
      readSessions: true,
      readBodies: true,
      readRawBodies: false,
      readWebSocket: true,
      exportSnapshots: false,
      controlCapture: true,
      controlSystemProxy: true,
      manageCertificates: true,
      deleteSessions: true,
      sendRequests: true,
      manageRules: true,
    });
  });

  it("infers an exact preset or preserves custom permissions", () => {
    expect(presetForPermissions(permissionsForPreset("metadata"))).toBe("metadata");
    expect(presetForPermissions(permissionsForPreset("bodies"))).toBe("bodies");
    expect(presetForPermissions(permissionsForPreset("raw"))).toBe("raw");
    expect(presetForPermissions(permissionsForPreset("full"))).toBe("full");
    expect(
      presetForPermissions({
        ...permissionsForPreset("metadata"),
        readWebSocket: true,
      }),
    ).toBe("current");
    expect(
      presetForPermissions({
        ...permissionsForPreset("bodies"),
        controlCapture: true,
      }),
    ).toBe("current");
  });

  it("keeps the exact custom permission mix when reconnecting", () => {
    const current = {
      ...permissionsForPreset("bodies"),
      controlCapture: true,
      deleteSessions: true,
    };
    expect(permissionsForConnectPreset("current", current)).toEqual(current);
    expect(permissionsForConnectPreset("metadata", current)).toEqual(
      permissionsForPreset("metadata"),
    );
  });

  it("compares every permission flag", () => {
    const base = permissionsForPreset("bodies");
    expect(permissionsEqual(base, { ...base })).toBe(true);
    expect(permissionsEqual(base, { ...base, readRawBodies: true })).toBe(false);
    expect(permissionsEqual(base, { ...base, readWebSocket: false })).toBe(false);
    expect(permissionsEqual(base, { ...base, exportSnapshots: true })).toBe(false);
    expect(permissionsEqual(base, { ...base, controlCapture: true })).toBe(false);
    expect(permissionsEqual(base, { ...base, deleteSessions: true })).toBe(false);
    expect(permissionsEqual(base, { ...base, sendRequests: true })).toBe(false);
    expect(permissionsEqual(base, { ...base, manageRules: true })).toBe(false);
  });
});
