import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BreakpointRule } from "@aiproxy/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BreakpointRulesPanel } from "./BreakpointRulesPanel";

// --- Controllable mock fixtures -------------------------------------------
// The auto-select effect depends on the `rules` array identity returned by the
// query hook, so we drive it through a module-level mutable holder exactly the
// way MapRulesPanel.test.tsx does.
const rulesState: { current: BreakpointRule[] } = { current: [] };
// Breakpoint rules persist as one whole list; every mutation (save / toggle /
// delete / batch / reorder) goes through this single mock. onSuccess/onSettled
// fire synchronously so dialogs close and selections reset like the real
// mutation.
const setRulesMutateMock = vi.fn(
  (_rules: BreakpointRule[], options?: { onSuccess?: () => void; onSettled?: () => void }) => {
    options?.onSuccess?.();
    options?.onSettled?.();
  },
);

vi.mock("@/features/breakpoints/use-breakpoint-rules", () => ({
  useBreakpointRules: () => ({ data: rulesState.current, isError: false }),
  useSetBreakpointRules: () => ({ mutate: setRulesMutateMock, isPending: false, error: null }),
}));

// P0-2 unsaved-changes guard: never blocked in these multi-action tests.
vi.mock("react-router-dom", () => ({
  useBlocker: () => ({ state: "unblocked" as const, proceed: vi.fn(), reset: vi.fn() }),
  useBeforeUnload: () => {},
}));

// Keep the test free of the i18n provider dependency.
vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      const value = params.count ?? params.index;
      return value === undefined ? key : `${key}:${value}`;
    },
    tList: (key: string) => [key],
    locale: "en-US",
  }),
}));

function makeRule(overrides: Partial<BreakpointRule> = {}): BreakpointRule {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    urlPattern: "api.example.com",
    methods: [],
    stage: "request",
    ...overrides,
  };
}

// Remove lives in the editor's "..." overflow menu since the workbench
// alignment; reaching it is part of every delete test.
function openRemoveMenuItem() {
  fireEvent.click(screen.getByLabelText("rulesPage.ruleActions"));
  fireEvent.click(screen.getByRole("menuitem", { name: "common.actions.remove" }));
}

beforeEach(() => {
  rulesState.current = [];
  setRulesMutateMock.mockClear();
});

describe("BreakpointRulesPanel — empty state and create entry", () => {
  it("shows the empty description with the create actions when no rules exist", () => {
    render(<BreakpointRulesPanel />);

    expect(screen.getByText("rulesPage.breakpoint.emptyDescription")).toBeInTheDocument();
    // The empty state keeps every create path reachable, including import-style
    // secondary actions (quick catch-alls).
    expect(
      screen.getByRole("button", { name: "rulesPage.breakpoint.createRule" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "rulesPage.breakOnAllRequests" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "rulesPage.breakOnAllResponses" }),
    ).toBeInTheDocument();
  });

  it("creates a draft inline (no dialog) and saves it by appending to the list", async () => {
    render(<BreakpointRulesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.breakpoint.createRule" }));

    // The create handler awaits the guard promise, so the transition flushes
    // in a microtask; wait for the editor to catch up.
    const patternField = (await screen.findByLabelText(
      "rulesPage.editor.urlPattern",
    )) as HTMLInputElement;
    expect(patternField.value).toBe("");

    fireEvent.change(patternField, { target: { value: "api.example.com/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));

    expect(setRulesMutateMock).toHaveBeenCalledTimes(1);
    const savedList = setRulesMutateMock.mock.calls[0]?.[0] as BreakpointRule[];
    expect(savedList).toHaveLength(1);
    expect(savedList[0]).toMatchObject({
      enabled: true,
      urlPattern: "api.example.com/v1",
      stage: "request",
      methods: [],
    });
  });

  it("appends a newly created rule at the END of the list order", async () => {
    const ruleA = makeRule({ id: "rule-a", urlPattern: "a.example.com" });
    rulesState.current = [ruleA];

    render(<BreakpointRulesPanel />);

    // The first rule is auto-selected into the editor.
    expect(screen.getByDisplayValue("a.example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.breakpoint.createRule" }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue("a.example.com")).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("rulesPage.editor.urlPattern"), {
      target: { value: "b.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));

    const savedList = setRulesMutateMock.mock.calls[0]?.[0] as BreakpointRule[];
    expect(savedList.map((rule) => rule.urlPattern)).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("BreakpointRulesPanel — validation (R3)", () => {
  it("shows helperText on empty submit and does not persist", async () => {
    render(<BreakpointRulesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));

    await waitFor(() => {
      expect(screen.getByText("rulesPage.validation.urlPatternRequired")).toBeInTheDocument();
    });
    expect(setRulesMutateMock).not.toHaveBeenCalled();
  });

  it("clears the field error once the user fixes the pattern", async () => {
    render(<BreakpointRulesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));
    await waitFor(() => {
      expect(screen.getByText("rulesPage.validation.urlPatternRequired")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("rulesPage.editor.urlPattern"), {
      target: { value: "api.example.com" },
    });

    expect(screen.queryByText("rulesPage.validation.urlPatternRequired")).not.toBeInTheDocument();
  });
});

describe("BreakpointRulesPanel — edit and quick catch-all", () => {
  it("saves edits to the selected rule in place, keeping list order", () => {
    const ruleA = makeRule({ id: "rule-a", urlPattern: "a.example.com" });
    const ruleB = makeRule({ id: "rule-b", urlPattern: "b.example.com" });
    rulesState.current = [ruleA, ruleB];

    render(<BreakpointRulesPanel />);

    fireEvent.change(screen.getByLabelText("rulesPage.editor.urlPattern"), {
      target: { value: "a.example.com/v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));

    const savedList = setRulesMutateMock.mock.calls[0]?.[0] as BreakpointRule[];
    expect(savedList).toHaveLength(2);
    expect(savedList[0]).toMatchObject({ id: "rule-a", urlPattern: "a.example.com/v2" });
    expect(savedList[1]).toEqual(ruleB);
  });

  it("adds a catch-all rule immediately from the quick action", () => {
    render(<BreakpointRulesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.breakOnAllRequests" }));

    expect(setRulesMutateMock).toHaveBeenCalledTimes(1);
    const savedList = setRulesMutateMock.mock.calls[0]?.[0] as BreakpointRule[];
    expect(savedList[0]).toMatchObject({ urlPattern: "*", stage: "request", enabled: true });
  });

  it("disables the quick action once an enabled catch-all exists for that stage", () => {
    rulesState.current = [makeRule({ id: "rule-a", urlPattern: "*", stage: "request" })];

    render(<BreakpointRulesPanel />);

    expect(screen.getByRole("button", { name: "rulesPage.breakOnAllRequests" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "rulesPage.breakOnAllResponses" })).toBeEnabled();
  });
});

describe("BreakpointRulesPanel — duplicate and delete (P0-2)", () => {
  it("duplicates the selected rule into a new draft without persisting", async () => {
    const ruleA = makeRule({ id: "rule-a", urlPattern: "a.example.com" });
    rulesState.current = [ruleA];

    render(<BreakpointRulesPanel />);

    fireEvent.click(screen.getByLabelText("rulesPage.ruleActions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "rulesPage.duplicateRule" }));

    // The duplicate is only an editor draft until saved.
    await waitFor(() => {
      expect(screen.getByDisplayValue("a.example.com")).toBeInTheDocument();
    });
    expect(setRulesMutateMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));
    const savedList = setRulesMutateMock.mock.calls[0]?.[0] as BreakpointRule[];
    expect(savedList).toHaveLength(2);
    expect(savedList[0]?.id).toBe("rule-a");
    expect(savedList[1]?.urlPattern).toBe("a.example.com");
    expect(savedList[1]?.id).not.toBe("rule-a");
  });

  it("requires confirmation before a persisted rule is deleted", () => {
    rulesState.current = [makeRule({ id: "rule-a", urlPattern: "a.example.com" })];

    render(<BreakpointRulesPanel />);

    openRemoveMenuItem();
    expect(setRulesMutateMock).not.toHaveBeenCalled();
    expect(screen.getByText("rulesPage.deleteBreakpointTitle")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "common.actions.delete" }));
    const savedList = setRulesMutateMock.mock.calls[0]?.[0] as BreakpointRule[];
    expect(savedList).toEqual([]);
  });

  it("cancelling the delete dialog keeps the rule", () => {
    rulesState.current = [makeRule({ id: "rule-a" })];

    render(<BreakpointRulesPanel />);

    openRemoveMenuItem();
    fireEvent.click(screen.getByRole("button", { name: "common.actions.cancel" }));

    expect(setRulesMutateMock).not.toHaveBeenCalled();
  });

  it("discards an unsaved new draft without a confirmation dialog", async () => {
    const ruleA = makeRule({ id: "rule-a", urlPattern: "a.example.com" });
    rulesState.current = [ruleA];

    render(<BreakpointRulesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.breakpoint.createRule" }));
    await waitFor(() => {
      expect(screen.queryByDisplayValue("a.example.com")).not.toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("rulesPage.editor.urlPattern"), {
      target: { value: "unsaved.example.com" },
    });

    openRemoveMenuItem();

    // Nothing was persisted yet, so Remove just drops the draft — no dialog,
    // no mutation — and the editor falls back to the first saved rule.
    expect(screen.queryByText("rulesPage.deleteBreakpointTitle")).not.toBeInTheDocument();
    expect(setRulesMutateMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByDisplayValue("a.example.com")).toBeInTheDocument();
    });
  });
});

describe("BreakpointRulesPanel — batch operations (R5)", () => {
  it("bulk-disables the selected rules", async () => {
    rulesState.current = [
      makeRule({ id: "rule-a", urlPattern: "a.example.com" }),
      makeRule({ id: "rule-b", urlPattern: "b.example.com" }),
    ];

    render(<BreakpointRulesPanel />);

    // The i18n mock collapses `selectRule` params, so both checkboxes share
    // one label; DOM order follows the persisted list order.
    const selectBoxes = screen.getAllByLabelText("rulesPage.batch.selectRule");
    fireEvent.click(selectBoxes[0]!);
    fireEvent.click(selectBoxes[1]!);

    expect(screen.getByText("rulesPage.batch.selectedCount:2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.batch.disable" }));

    await waitFor(() => {
      expect(setRulesMutateMock).toHaveBeenCalledTimes(1);
    });
    const savedList = setRulesMutateMock.mock.calls[0]?.[0] as BreakpointRule[];
    expect(savedList.map((rule) => rule.enabled)).toEqual([false, false]);
  });

  it("asks for confirmation before batch-deleting selected rules", async () => {
    rulesState.current = [makeRule({ id: "rule-a", urlPattern: "a.example.com" })];

    render(<BreakpointRulesPanel />);

    fireEvent.click(screen.getByLabelText("rulesPage.batch.selectRule"));
    fireEvent.click(screen.getByRole("button", { name: "rulesPage.batch.delete" }));

    // No deletion happens before the confirmation is accepted.
    expect(setRulesMutateMock).not.toHaveBeenCalled();
    expect(screen.getByText("rulesPage.batch.deleteConfirmTitle")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "common.actions.delete" }));
    await waitFor(() => expect(setRulesMutateMock).toHaveBeenCalledTimes(1));
    const savedList = setRulesMutateMock.mock.calls[0]?.[0] as BreakpointRule[];
    expect(savedList).toEqual([]);
  });
});
