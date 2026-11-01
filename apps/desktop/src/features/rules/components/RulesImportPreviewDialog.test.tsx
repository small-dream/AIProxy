import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationStore } from "@/services/notification.store";

import { RulesImportPreviewDialog } from "./RulesImportPreviewDialog";

const saveRewriteRule = vi.fn();
const setBreakpointRules = vi.fn();

vi.mock("@/services/commands", () => ({
  saveDnsMapping: vi.fn().mockResolvedValue(undefined),
  saveMapRule: vi.fn().mockResolvedValue(undefined),
  saveRewriteRule: (rule: unknown) => saveRewriteRule(rule),
  saveScriptRule: vi.fn().mockResolvedValue(undefined),
  setBreakpointRules: (rules: unknown) => setBreakpointRules(rules),
}));

vi.mock("@/services/commands/throttling", () => ({
  saveThrottleProfile: vi.fn().mockResolvedValue(undefined),
  saveThrottleRule: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/breakpoints/use-breakpoint-rules", () => ({
  useBreakpointRules: () => ({ data: [] }),
}));

vi.mock("@/features/throttling/use-throttle-profiles", () => ({
  useThrottleProfiles: () => ({ data: [] }),
}));

// The regenerators are pure and covered by their own helpers tests; here they
// only need to produce one entry per imported rule.
vi.mock("@/features/rules/rules-import-export.helpers", () => ({
  planRulesImport: (file: unknown) => ({
    counts: {
      breakpoint: 2,
      dns: 0,
      map: 0,
      rewrite: 2,
      script: 0,
      throttle: 0,
      throttleProfiles: 0,
    },
    file,
  }),
  regenerateImportedBreakpointRules: (rules: unknown[]) => rules,
  regenerateImportedProfiles: (profiles: unknown[]) => profiles,
  regenerateImportedRules: (rules: unknown[]) => rules,
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

const importFile = {
  exportedAt: "2026-11-01T00:00:00Z",
  format: "aiproxy.rules",
  rules: {
    breakpoint: [{ id: "bp-1" }, { id: "bp-2" }],
    dns: [],
    map: [],
    rewrite: [{ id: "rw-1" }, { id: "rw-2" }],
    script: [],
    throttle: [],
    throttleProfiles: [],
  },
  version: 1,
} as never;

function importButton() {
  return screen.getByRole("button", { name: /importButton/i });
}

beforeEach(() => {
  saveRewriteRule.mockReset();
  saveRewriteRule.mockResolvedValue(undefined);
  setBreakpointRules.mockReset();
  setBreakpointRules.mockResolvedValue(undefined);
  useNotificationStore.setState({ queue: [] });
});

// P2-19: the import runs rule-by-rule with awaits, and a second click during
// that window started a second concurrent run — every rule got a fresh id, so
// the file really was imported twice.
describe("RulesImportPreviewDialog pending guard", () => {
  it("runs the import once even when the button is clicked twice", async () => {
    let releaseFirstSave: (() => void) | undefined;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    saveRewriteRule.mockImplementationOnce(() => firstSave);

    render(<RulesImportPreviewDialog file={importFile} onClose={vi.fn()} />);

    fireEvent.click(importButton());
    await waitFor(() => expect(saveRewriteRule).toHaveBeenCalledTimes(1));

    fireEvent.click(importButton());
    expect(saveRewriteRule).toHaveBeenCalledTimes(1);

    releaseFirstSave?.();
    await waitFor(() => expect(setBreakpointRules).toHaveBeenCalledTimes(1));
    // Both rewrite rules were imported exactly once.
    expect(saveRewriteRule).toHaveBeenCalledTimes(2);
  });

  it("counts a failed batched breakpoint import per rule", async () => {
    setBreakpointRules.mockRejectedValue(new Error("busy"));

    render(<RulesImportPreviewDialog file={importFile} onClose={vi.fn()} />);

    fireEvent.click(importButton());

    await waitFor(() => expect(useNotificationStore.getState().queue).toHaveLength(1));
    const message = useNotificationStore.getState().queue[0]?.message ?? "";

    // Two rewrite rules saved, both breakpoint rules failed as one batch.
    expect(message).toContain("rulesPage.importExport.importedPartial");
    expect(message).toContain('"success":2');
    expect(message).toContain('"failed":2');
  });
});
