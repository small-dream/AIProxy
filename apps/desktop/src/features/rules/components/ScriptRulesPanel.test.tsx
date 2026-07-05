import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ScriptRule } from "@aiproxy/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ScriptRulesPanel } from "./ScriptRulesPanel";

// --- Controllable mock fixtures -------------------------------------------
// Mirrors the mock strategy in MapRulesPanel.test.tsx: module-level mutable
// holders drive hook return values so each test can seed its own state.
const pickAndReadScriptFileMock = vi.fn();
const rulesState: { current: ScriptRule[] } = { current: [] };

vi.mock("@/services/commands", () => ({
  pickAndReadScriptFile: (...args: unknown[]) => pickAndReadScriptFileMock(...args),
}));

vi.mock("@/features/rules/use-rule-center", () => ({
  useScriptRules: () => ({ data: rulesState.current, isError: false }),
  useSaveScriptRule: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteManagedRule: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Keep the test free of the i18n provider dependency. The fake `t` returns the
// key verbatim, but when interpolation params are supplied it appends the
// `message` value so the L10 test can assert the error context is surfaced.
vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && typeof params.message === "string" ? `${key}:${params.message}` : key,
    tList: (key: string) => [key],
    locale: "en-US",
  }),
}));

beforeEach(() => {
  pickAndReadScriptFileMock.mockReset();
  rulesState.current = [];
});

function makeRule(overrides: Partial<ScriptRule> = {}): ScriptRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: "default",
    name: "",
    note: "",
    enabled: true,
    priority: 100,
    match: { urlPattern: "*", methods: [], stage: "either" },
    language: "javascript",
    sourceType: "inline",
    sourceCode: "",
    entrypoints: { onRequest: true, onResponse: false },
    ...overrides,
  };
}

describe("ScriptRulesPanel — file import error feedback (L10)", () => {
  it("surfaces an error notification when the script import fails instead of failing silently", async () => {
    // Before the fix the catch block was empty: a failed file import gave the
    // user zero feedback, violating CLAUDE.md "no empty catch".
    // H10 (closed): import is a single backend-owned command (dialog + read).
    pickAndReadScriptFileMock.mockRejectedValue(new Error("disk read failed"));

    // Spy on the global notification store so the test does not depend on the
    // AppShell Snackbar plumbing; we assert push() is called with context.
    const { useNotificationStore } = await import("@/services/notification.store");
    const pushSpy = vi.spyOn(useNotificationStore.getState(), "push");

    render(<ScriptRulesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.script.importFile" }));

    await waitFor(() => {
      expect(pickAndReadScriptFileMock).toHaveBeenCalledTimes(1);
      expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    // The notification must carry the error message (context), not be empty.
    const callArgs = pushSpy.mock.calls[0]!;
    const message = callArgs[0];
    expect(message).toBeTruthy();
    expect(message).toContain("rulesPage.script.importFailed");
    expect(message).toMatch(/disk read failed/);
  });
});

describe("ScriptRulesPanel — selection sync guard (M22/M25)", () => {
  it("does NOT clobber an in-progress edit when the rules query refetches (new array identity, same data)", () => {
    // M22: the selection effect used to fire on every `rules[]` array identity
    // change (TanStack Query refetch returns a new array even when data is
    // identical), re-syncing the draft from the server value and discarding
    // the user's in-progress edit. The lastSyncedRuleIdRef guard makes the
    // sync fire only when the selected id actually changes.
    const rule = makeRule({ id: "rule-a", name: "Original", priority: 200 });
    rulesState.current = [rule];

    const { rerender } = render(<ScriptRulesPanel />);

    // The rule is selected and its name populates the editor.
    const nameField = screen.getByLabelText(
      /rulesPage\.editor\.ruleName/i,
    ) as HTMLInputElement;
    expect(nameField.value).toBe("Original");

    // User edits the draft in place.
    fireEvent.change(nameField, { target: { value: "My In-Progress Edit" } });
    expect(
      (screen.getByLabelText(/rulesPage\.editor\.ruleName/i) as HTMLInputElement).value,
    ).toBe("My In-Progress Edit");

    // Simulate a TanStack Query refetch: same data, but a NEW array identity
    // (the real query hook returns a fresh array on every refetch).
    rulesState.current = [makeRule({ id: "rule-a", name: "Original", priority: 200 })];
    rerender(<ScriptRulesPanel />);

    // The in-progress edit MUST survive — the selection effect must not
    // re-sync the draft from the server value.
    expect(
      (screen.getByLabelText(/rulesPage\.editor\.ruleName/i) as HTMLInputElement).value,
    ).toBe("My In-Progress Edit");
  });
});
