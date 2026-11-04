import { describe, expect, it } from "vitest";

import type { AgentAccessPermissions } from "@aiproxy/shared-types";

import {
  permissionsForConnectPreset,
  permissionsEqual,
  permissionsForPreset,
  presetForPermissions,
  type AgentPermissionPreset,
} from "./agent-access.helpers";
import { AGENT_PERMISSION_KEYS } from "./agent-access.permissions";

function expectOnlyEnabled(
  permissions: AgentAccessPermissions,
  enabled: readonly (keyof AgentAccessPermissions)[],
) {
  for (const key of AGENT_PERMISSION_KEYS) {
    expect(permissions[key], key).toBe(enabled.includes(key));
  }
}

describe("Agent permission presets", () => {
  it("maps each preset to a concrete, minimal scope", () => {
    expectOnlyEnabled(permissionsForPreset("metadata"), ["readSessions"]);
    expectOnlyEnabled(permissionsForPreset("readOnly"), ["readSessions", "readBodies"]);
    expectOnlyEnabled(permissionsForPreset("debugReplay"), [
      "readSessions",
      "readBodies",
      "sendRequests",
    ]);
    expectOnlyEnabled(permissionsForPreset("automationExperiment"), [
      "readSessions",
      "readBodies",
      "manageAutomation",
    ]);
  });

  it("does not bundle unrelated control or optional capabilities into a preset", () => {
    const debugReplay = permissionsForPreset("debugReplay");
    expect(debugReplay.manageAutomation).toBe(false);
    expect(debugReplay.controlCapture).toBe(false);
    expect(debugReplay.controlSystemProxy).toBe(false);

    const automation = permissionsForPreset("automationExperiment");
    expect(automation.controlCapture).toBe(false);
    expect(automation.controlSystemProxy).toBe(false);
    expect(automation.manageCertificates).toBe(false);
    expect(automation.manageUserAutomation).toBe(false);
    expect(automation.manageProxiedVerification).toBe(false);
    expect(automation.readRawBodies).toBe(false);
    expect(automation.readWebSocket).toBe(false);
  });

  it("infers an exact preset or preserves custom permissions", () => {
    for (const preset of [
      "metadata",
      "readOnly",
      "debugReplay",
      "automationExperiment",
    ] as const satisfies readonly AgentPermissionPreset[]) {
      expect(presetForPermissions(permissionsForPreset(preset))).toBe(preset);
    }
    expect(
      presetForPermissions({
        ...permissionsForPreset("metadata"),
        readWebSocket: true,
      }),
    ).toBe("current");
    expect(
      presetForPermissions({
        ...permissionsForPreset("readOnly"),
        controlCapture: true,
      }),
    ).toBe("current");
  });

  it("keeps the exact custom permission mix when reconnecting", () => {
    const current = {
      ...permissionsForPreset("readOnly"),
      controlCapture: true,
      deleteSessions: true,
    };
    expect(permissionsForConnectPreset("current", current)).toEqual(current);
    expect(permissionsForConnectPreset("metadata", current)).toEqual(
      permissionsForPreset("metadata"),
    );
  });

  it("compares every permission flag", () => {
    const base = permissionsForPreset("readOnly");
    expect(permissionsEqual(base, { ...base })).toBe(true);
    for (const key of AGENT_PERMISSION_KEYS) {
      expect(permissionsEqual(base, { ...base, [key]: !base[key] }), key).toBe(false);
    }
  });
});
