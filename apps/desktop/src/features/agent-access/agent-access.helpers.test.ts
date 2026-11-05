import { describe, expect, it } from "vitest";

import type { AgentAccessPermissions } from "@aiproxy/shared-types";

import {
  accessForConnectPreset,
  accessForPreset,
  deniedGrantRequestPolicy,
  grantRequestPoliciesEqual,
  permissionsEqual,
  permissionsForPreset,
  presetForPermissions,
} from "./agent-access.helpers";
import { AGENT_PERMISSION_KEYS, availablePermissionDefinitions } from "./agent-access.permissions";

function expectOnlyEnabled(
  permissions: AgentAccessPermissions,
  enabled: readonly (keyof AgentAccessPermissions)[],
) {
  for (const key of AGENT_PERMISSION_KEYS) {
    expect(permissions[key], key).toBe(enabled.includes(key));
  }
}

describe("Agent permission presets", () => {
  it("keeps read-only analysis conservative and denies temporary escalation", () => {
    const access = accessForPreset("readOnly");
    expectOnlyEnabled(access.permissions, ["readSessions", "readBodies"]);
    expect(access.grantRequestPolicy).toEqual(deniedGrantRequestPolicy());
  });

  it("enables every capability available in this release for full control", () => {
    const availableKeys = availablePermissionDefinitions().map((definition) => definition.key);
    expectOnlyEnabled(permissionsForPreset("fullControl"), availableKeys);
    expect(availableKeys).not.toContain("exportSnapshots");
    expect(availableKeys).not.toContain("manageScripts");
    expect(availableKeys).not.toContain("manageCrossHostMappings");
    expect(availableKeys).not.toContain("manageGlobalAutomation");
  });

  it("infers an exact preset or marks the access as custom", () => {
    for (const preset of ["readOnly", "fullControl"] as const) {
      expect(presetForPermissions(accessForPreset(preset).permissions)).toBe(preset);
    }
    expect(
      presetForPermissions({
        ...accessForPreset("readOnly").permissions,
        controlCapture: true,
      }),
    ).toBe("custom");
  });

  it("treats a non-denied grant policy as custom even when permissions match", () => {
    expect(
      presetForPermissions(accessForPreset("readOnly").permissions, {
        ...deniedGrantRequestPolicy(),
        readBodies: "ask",
      }),
    ).toBe("custom");
  });

  it("keeps the exact custom access mix when reconnecting", () => {
    const current = {
      permissions: {
        ...accessForPreset("readOnly").permissions,
        controlCapture: true,
        deleteSessions: true,
      },
      grantRequestPolicy: {
        ...deniedGrantRequestPolicy(),
        deleteSessions: "ask" as const,
      },
    };
    expect(accessForConnectPreset("custom", current)).toEqual(current);
    expect(accessForConnectPreset("readOnly", current)).toEqual(accessForPreset("readOnly"));
  });

  it("compares every permission flag and request policy", () => {
    const base = accessForPreset("readOnly");
    expect(permissionsEqual(base.permissions, { ...base.permissions })).toBe(true);
    expect(grantRequestPoliciesEqual(base.grantRequestPolicy, { ...base.grantRequestPolicy })).toBe(
      true,
    );
    for (const key of AGENT_PERMISSION_KEYS) {
      expect(
        permissionsEqual(base.permissions, { ...base.permissions, [key]: !base.permissions[key] }),
        key,
      ).toBe(false);
      expect(
        grantRequestPoliciesEqual(base.grantRequestPolicy, {
          ...base.grantRequestPolicy,
          [key]: "ask",
        }),
        key,
      ).toBe(base.grantRequestPolicy[key] === "ask");
    }
  });
});
