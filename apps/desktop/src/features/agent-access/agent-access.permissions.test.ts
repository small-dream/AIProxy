import type { AgentAccessPermissions } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import {
  AGENT_PERMISSION_DEFINITIONS,
  AGENT_PERMISSION_KEYS,
  availablePermissionDefinitions,
  countEnabledPermissions,
  hasUnmetPermissionDependencies,
  isAgentAdvancedPermissionTarget,
  isAgentPermissionMatrixTarget,
  permissionDefinition,
  requiresPermissionConfirmation,
} from "./agent-access.permissions";

function emptyPermissions(): AgentAccessPermissions {
  return Object.fromEntries(
    AGENT_PERMISSION_KEYS.map((key) => [key, false]),
  ) as AgentAccessPermissions;
}

describe("Agent permission metadata", () => {
  it("defines every permission exactly once with a unique UI target", () => {
    expect(AGENT_PERMISSION_DEFINITIONS.map((definition) => definition.key)).toEqual([
      ...AGENT_PERMISSION_KEYS,
    ]);

    const targetIds = AGENT_PERMISSION_DEFINITIONS.map((definition) => definition.targetId);
    expect(new Set(targetIds).size).toBe(targetIds.length);
    expect(targetIds.every(Boolean)).toBe(true);
  });

  it("keeps reserved permissions hidden from selectable capabilities", () => {
    for (const key of [
      "exportSnapshots",
      "manageScripts",
      "manageCrossHostMappings",
      "manageGlobalAutomation",
    ] as const) {
      expect(permissionDefinition(key).available).toBe(false);
    }

    const availableKeys = availablePermissionDefinitions().map((definition) => definition.key);
    expect(availableKeys).not.toContain("manageScripts");
    expect(availableKeys).not.toContain("manageCrossHostMappings");
    expect(availableKeys).not.toContain("manageGlobalAutomation");
  });

  it("opens the correct disclosure level for search targets", () => {
    expect(isAgentPermissionMatrixTarget("agent-control-system-proxy")).toBe(true);
    expect(isAgentPermissionMatrixTarget("agent-read-raw-bodies")).toBe(true);
    expect(isAgentAdvancedPermissionTarget("agent-read-raw-bodies")).toBe(true);
    expect(isAgentPermissionMatrixTarget("agent-detect-sensitive-values")).toBe(true);
    expect(isAgentAdvancedPermissionTarget("agent-detect-sensitive-values")).toBe(true);
    expect(isAgentAdvancedPermissionTarget("agent-control-system-proxy")).toBe(false);
    expect(isAgentPermissionMatrixTarget("agent-audit")).toBe(false);
  });

  it("only counts available capabilities and confirms newly enabled high-risk grants", () => {
    const before = emptyPermissions();
    const after = { ...before, readSessions: true, manageScripts: true };

    expect(countEnabledPermissions(after)).toBe(1);
    expect(requiresPermissionConfirmation(before, { ...before, controlCapture: true })).toBe(false);
    expect(requiresPermissionConfirmation(before, { ...before, controlSystemProxy: true })).toBe(
      true,
    );
  });

  it("tracks capability dependencies in the shared metadata", () => {
    const before = emptyPermissions();

    expect(permissionDefinition("readRawBodies").requires).toEqual(["readBodies"]);
    expect(permissionDefinition("manageProxiedVerification").requires).toEqual([
      "manageAutomation",
    ]);
    expect(hasUnmetPermissionDependencies(before, "readRawBodies")).toBe(true);
    expect(hasUnmetPermissionDependencies({ ...before, readBodies: true }, "readRawBodies")).toBe(
      false,
    );
    expect(
      hasUnmetPermissionDependencies(
        { ...before, manageProxiedVerification: true },
        "manageProxiedVerification",
      ),
    ).toBe(true);
    expect(
      hasUnmetPermissionDependencies(
        { ...before, manageAutomation: true, manageProxiedVerification: true },
        "manageProxiedVerification",
      ),
    ).toBe(false);
  });
});
