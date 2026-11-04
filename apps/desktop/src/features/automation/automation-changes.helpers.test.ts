import type { AutomationVerificationRecord } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import {
  formatAutomationDate,
  formatAutomationValue,
  groupAutomationVerifications,
} from "./automation-changes.helpers";

describe("automation change helpers", () => {
  it("redacts sensitive assertion values before rendering", () => {
    const output = formatAutomationValue({
      Authorization: "Bearer secret",
      nested: { accessToken: "value", ok: true },
    });
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("Bearer secret");
    expect(output).not.toContain("value");
  });

  it("keeps invalid dates visible for diagnosis", () => {
    expect(formatAutomationDate("not-a-date", "none")).toBe("not-a-date");
    expect(formatAutomationDate(null, "none")).toBe("none");
  });

  it("groups verification records by evidence mode", () => {
    const record = (id: string, mode: AutomationVerificationRecord["mode"]) =>
      ({ id, mode }) as AutomationVerificationRecord;
    const grouped = groupAutomationVerifications([
      record("offline-1", "offline"),
      record("proxy-1", "proxy"),
      record("external-1", "external"),
      record("proxy-2", "proxy"),
    ]);
    expect(grouped.offline).toHaveLength(1);
    expect(grouped.proxy).toHaveLength(2);
    expect(grouped.external).toHaveLength(1);
  });
});
