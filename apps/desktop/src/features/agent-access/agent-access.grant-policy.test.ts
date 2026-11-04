import { describe, expect, it } from "vitest";

import {
  applyCapabilityMode,
  capabilityMode,
  capabilitySupportsTemporaryApproval,
  defaultGrantRequestPolicy,
  requiresAccessChangeConfirmation,
} from "./agent-access.grant-policy";
import { permissionsForPreset } from "./agent-access.helpers";

describe("Agent capability mode policy", () => {
  it("defaults destructive controls to blocked and other capabilities to ask", () => {
    const policy = defaultGrantRequestPolicy();
    expect(policy.readSessions).toBe("deny");
    expect(policy.controlSystemProxy).toBe("deny");
    expect(policy.manageCertificates).toBe("deny");
    expect(policy.deleteSessions).toBe("deny");
    expect(policy.manageScripts).toBe("deny");
    expect(policy.manageCrossHostMappings).toBe("deny");
    expect(policy.manageUserAutomation).toBe("deny");
    expect(policy.manageGlobalAutomation).toBe("deny");
    expect(policy.readBodies).toBe("ask");
    expect(policy.sendRequests).toBe("ask");
  });

  it("does not expose an unexecutable ask mode for session metadata", () => {
    const permissions = permissionsForPreset("metadata");
    const policy = { ...defaultGrantRequestPolicy(), readSessions: "ask" as const };
    const denied = { ...permissions, readSessions: false };

    expect(capabilitySupportsTemporaryApproval("readSessions")).toBe(false);
    expect(capabilityMode(denied, policy, "readSessions")).toBe("deny");
    expect(
      applyCapabilityMode(denied, policy, "readSessions", "ask").grantRequestPolicy.readSessions,
    ).toBe("deny");
  });

  it("maps the three UI states to one mutually exclusive backend state", () => {
    const permissions = permissionsForPreset("metadata");
    const policy = defaultGrantRequestPolicy();

    const always = applyCapabilityMode(permissions, policy, "sendRequests", "always");
    expect(always.permissions.sendRequests).toBe(true);
    expect(capabilityMode(always.permissions, always.grantRequestPolicy, "sendRequests")).toBe(
      "always",
    );

    const ask = applyCapabilityMode(
      always.permissions,
      always.grantRequestPolicy,
      "sendRequests",
      "ask",
    );
    expect(ask.permissions.sendRequests).toBe(false);
    expect(capabilityMode(ask.permissions, ask.grantRequestPolicy, "sendRequests")).toBe("ask");

    const deny = applyCapabilityMode(
      ask.permissions,
      ask.grantRequestPolicy,
      "sendRequests",
      "deny",
    );
    expect(deny.permissions.sendRequests).toBe(false);
    expect(deny.grantRequestPolicy.sendRequests).toBe("deny");
  });

  it("blocks raw body access when body access is no longer always allowed", () => {
    const permissions = {
      ...permissionsForPreset("readOnly"),
      readRawBodies: true,
    };
    const result = applyCapabilityMode(
      permissions,
      defaultGrantRequestPolicy(),
      "readBodies",
      "ask",
    );
    expect(result.permissions.readBodies).toBe(false);
    expect(result.permissions.readRawBodies).toBe(false);
  });

  it("requires confirmation when a high-impact capability leaves blocked", () => {
    const permissions = permissionsForPreset("metadata");
    const policy = defaultGrantRequestPolicy();
    expect(
      requiresAccessChangeConfirmation(permissions, policy, permissions, {
        ...policy,
        controlSystemProxy: "ask",
      }),
    ).toBe(true);
    expect(
      requiresAccessChangeConfirmation(permissions, policy, permissions, {
        ...policy,
        controlCapture: "ask",
      }),
    ).toBe(false);
  });

  it("requires confirmation when a high-impact capability becomes permanent", () => {
    const permissions = permissionsForPreset("metadata");
    const policy = defaultGrantRequestPolicy();
    const alwaysAllowed = applyCapabilityMode(permissions, policy, "sendRequests", "always");

    expect(
      requiresAccessChangeConfirmation(
        permissions,
        policy,
        alwaysAllowed.permissions,
        alwaysAllowed.grantRequestPolicy,
      ),
    ).toBe(true);
  });
});
