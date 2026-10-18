import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RewriteRule, SessionSummary } from "@aiproxy/shared-types";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RewriteRulesPanel,
  resolveRuleTestVerdict,
  type RewriteRulesPanelHandle,
} from "./RewriteRulesPanel";
import { useI18n } from "@/i18n";

const rulesState: { current: RewriteRule[] } = { current: [] };
const sessionsState: { current: SessionSummary[] } = { current: [] };
const saveMutateMock = vi.fn();
const deleteMutateMock = vi.fn();
const deleteRuleMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@/features/rules/use-rule-center", () => ({
  useRewriteRules: () => ({ data: rulesState.current, isError: false }),
  useSaveRewriteRule: () => ({ mutate: saveMutateMock, isPending: false }),
  useDeleteManagedRule: () => ({ mutate: deleteMutateMock, isPending: false }),
  useBulkUpdateRules: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/features/sessions/use-sessions", () => ({
  useSessions: () => ({ data: sessionsState.current, isLoading: false, isError: false }),
}));

vi.mock("@/services/commands", () => ({
  deleteRule: deleteRuleMock,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  };
});

const routerState = vi.hoisted(() => ({ current: null as unknown }));
const navigateMock = vi.hoisted(() => vi.fn());
// The real router hands the SAME location object to every render of one
// history entry; effects keyed on location.state identity rely on that
// stability (a vetoed seed must not re-prompt on every re-render). Cache the
// mocked location so its identity only changes when the state content does.
const locationCache = vi.hoisted(() => ({
  forState: undefined as unknown,
  value: null as unknown,
}));
vi.mock("react-router-dom", () => ({
  useLocation: () => {
    if (locationCache.forState !== routerState.current) {
      locationCache.forState = routerState.current;
      locationCache.value = { pathname: "/rules", state: routerState.current, key: "test-key" };
    }
    return locationCache.value;
  },
  useNavigate: () => navigateMock,
  // P0-2 unsaved-changes guard: never dirty in these multi-action tests.
  useBlocker: () => ({ state: "unblocked" as const, proceed: vi.fn(), reset: vi.fn() }),
  useBeforeUnload: () => {},
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      const value = params.index ?? params.count;
      return value === undefined ? key : `${key}:${value}`;
    },
    tList: (key: string) => [key],
    locale: "en-US",
  }),
}));

function makeRule(overrides: Partial<RewriteRule> = {}): RewriteRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: "default",
    name: "",
    note: "",
    enabled: true,
    priority: 100,
    match: { urlPattern: "*", methods: [], stage: "either" },
    rewriteType: "header",
    actions: [
      {
        rewriteType: "header",
        payload: { target: "request", operation: "set", headerName: "x-test", value: "1" },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  rulesState.current = [];
  sessionsState.current = [];
  saveMutateMock.mockClear();
  deleteMutateMock.mockClear();
  deleteRuleMock.mockClear();
  navigateMock.mockClear();
  routerState.current = null;
});

// ── P0: tester verdict must fold in the invalid-combination check ────────
describe("resolveRuleTestVerdict", () => {
  const { t } = useI18n();
  const input = { method: "GET", stage: "request" as const, url: "https://api.example.com/x" };

  it("degrades a match to the blocked warning when the combination is invalid", () => {
    const verdict = resolveRuleTestVerdict(makeRule(), input, "some problem", t);
    expect(verdict).toEqual({
      ok: false,
      disabled: false,
      blocked: true,
      reason: "rulesPage.rewrite.tester.reasons.invalidCombination",
    });
  });

  it("keeps the green verdict when the combination is valid", () => {
    const verdict = resolveRuleTestVerdict(makeRule(), input, undefined, t);
    expect(verdict).toEqual({
      ok: true,
      disabled: false,
      blocked: false,
      reason: "rulesPage.rewrite.tester.reasons.matched",
    });
  });

  it("does not mask a plain non-match behind the blocked state", () => {
    const verdict = resolveRuleTestVerdict(
      makeRule({ match: { urlPattern: "nomatch", methods: [], stage: "request" } }),
      input,
      "some problem",
      t,
    );
    expect(verdict.blocked).toBe(false);
    expect(verdict.reason).toBe("rulesPage.rewrite.tester.reasons.urlMismatch");
  });

  it("keeps the disabled state distinct from blocked", () => {
    const verdict = resolveRuleTestVerdict(makeRule({ enabled: false }), input, "some problem", t);
    expect(verdict).toEqual({
      ok: false,
      disabled: true,
      blocked: false,
      reason: "rulesPage.rewrite.tester.reasons.disabled",
    });
  });
});

describe("RewriteRulesPanel — multi-action rules (R1)", () => {
  it("saves a rule with multiple ordered actions", async () => {
    render(<RewriteRulesPanel />);

    // "New rule" appears both in the create bar and inside the empty state.
    fireEvent.click(screen.getAllByRole("button", { name: "rulesPage.rewrite.newRule" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "rulesPage.rewrite.addAction" }));

    // Two action cards are now listed.
    expect(screen.getByText("rulesPage.rewrite.actionLabel:1")).toBeInTheDocument();
    expect(screen.getByText("rulesPage.rewrite.actionLabel:2")).toBeInTheDocument();

    // Fill the required rule-name field so validation passes, then save.
    fireEvent.change(screen.getByLabelText(/rulesPage\.editor\.ruleName/), {
      target: { value: "Multi action" },
    });
    fireEvent.change(screen.getByLabelText(/rulesPage\.editor\.urlPattern/), {
      target: { value: "example.com" },
    });
    // Both header actions need their required fields filled before save.
    const headerNameFields = screen.getAllByLabelText(/rulesPage\.rewrite\.headerName/);
    const headerValueFields = screen.getAllByLabelText(/rulesPage\.rewrite\.headerValue/);
    headerNameFields.forEach((field, index) =>
      fireEvent.change(field, { target: { value: `x-action-${index + 1}` } }),
    );
    headerValueFields.forEach((field) => fireEvent.change(field, { target: { value: "true" } }));
    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));

    await waitFor(() => {
      expect(saveMutateMock).toHaveBeenCalledTimes(1);
    });
    const saved = saveMutateMock.mock.calls[0]?.[0] as RewriteRule;
    expect(saved.actions).toHaveLength(2);
    expect(saved.actions[0]?.rewriteType).toBe("header");
    expect(saved.actions[1]?.rewriteType).toBe("header");
    expect(saved.rewriteType).toBe("header");
  });

  it("renders the action count in the list subtitle for multi-action rules", () => {
    rulesState.current = [
      makeRule({
        name: "Combined",
        actions: [
          {
            rewriteType: "header",
            payload: { target: "request", operation: "set", headerName: "a", value: "1" },
          },
          { rewriteType: "query", payload: { operation: "set", paramName: "b", value: "2" } },
        ],
        rewriteType: "header",
      }),
    ];

    render(<RewriteRulesPanel />);

    expect(screen.getByText("Combined")).toBeInTheDocument();
    expect(screen.getByText("rulesPage.rewrite.actionsSummary:2")).toBeInTheDocument();
  });

  it("blocks saving a rule that has no actions", async () => {
    rulesState.current = [
      makeRule({
        name: "Empty actions",
        actions: [],
        rewriteType: "header",
      }),
    ];

    render(<RewriteRulesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));

    await waitFor(() => {
      expect(screen.getByText("rulesPage.rewrite.actionsRequired")).toBeInTheDocument();
    });
    expect(saveMutateMock).not.toHaveBeenCalled();
  });

  // UI_GUIDELINES §9.4: an impossible stage/action combination must block
  // save with the inline warning, not persist a rule that can never fire.
  it("blocks saving a response-stage rule with a query action", async () => {
    rulesState.current = [
      makeRule({
        id: "rule-invalid-combo",
        name: "Response query rewrite",
        match: { urlPattern: "*", methods: [], stage: "response" },
        actions: [
          { rewriteType: "query", payload: { operation: "set", paramName: "b", value: "2" } },
        ],
        rewriteType: "query",
      }),
    ];

    render(<RewriteRulesPanel />);

    // P0: the warning is continuous — visible BEFORE any save attempt.
    await waitFor(() => {
      expect(
        screen.getByText("rulesPage.rewrite.invalidCombination.queryRedirectOnResponse"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));
    expect(saveMutateMock).not.toHaveBeenCalled();
  });

  // P0: a sample that matches an impossible rule must not show a green
  // "matched" — the verdict degrades to a distinct warning state.
  it("warns instead of matching when the sample matches an impossible rule", async () => {
    rulesState.current = [
      makeRule({
        id: "rule-blocked",
        name: "Request rule, response header",
        match: { urlPattern: "*", methods: [], stage: "request" },
        actions: [
          {
            rewriteType: "header",
            payload: { target: "response", operation: "set", headerName: "x-a", value: "1" },
          },
        ],
        rewriteType: "header",
      }),
    ];

    render(<RewriteRulesPanel />);

    await waitFor(() => {
      expect(
        screen.getByText("rulesPage.rewrite.tester.reasons.invalidCombination"),
      ).toBeInTheDocument();
    });
    // The specific problem is named (deep-link Alert + tester detail caption).
    expect(
      screen.getAllByText("rulesPage.rewrite.invalidCombination.headerTargetMismatchRequest")
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("rulesPage.rewrite.tester.reasons.matched")).not.toBeInTheDocument();
  });
});

// ── Restructure brief: priority auto-assign, batch-delete confirmation,
// overflow-menu duplicate, tester session picker ────────────────────────────
describe("RewriteRulesPanel — restructure behaviors", () => {
  function fillRequiredDraftFields() {
    fireEvent.change(screen.getByLabelText(/rulesPage\.editor\.urlPattern/), {
      target: { value: "example.com" },
    });
    fireEvent.change(screen.getByLabelText(/rulesPage\.rewrite\.headerName/), {
      target: { value: "x-debug" },
    });
    fireEvent.change(screen.getByLabelText(/rulesPage\.rewrite\.headerValue/), {
      target: { value: "true" },
    });
  }

  it("appends a new rule at the end of the priority order", async () => {
    rulesState.current = [
      makeRule({ id: "rule-top", name: "Top", priority: 50 }),
      makeRule({ id: "rule-bottom", name: "Bottom", priority: 30 }),
    ];
    render(<RewriteRulesPanel />);

    // Wait for the initial selection, then create through the bar button.
    await waitFor(() =>
      expect((screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement).value).toBe(
        "Top",
      ),
    );
    fireEvent.click(
      screen
        .getAllByRole("button", { name: "rulesPage.rewrite.newRule" })
        .find((button) => button.className.includes("contained"))!,
    );
    // handleCreateRule awaits the unsaved-changes guard, so the draft switch
    // lands a microtask later; editing before it would touch the old draft.
    await waitFor(() =>
      expect((screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement).value).toBe(
        "rulesPage.rewrite.newRuleDefaultName",
      ),
    );
    fillRequiredDraftFields();
    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));

    await waitFor(() => expect(saveMutateMock).toHaveBeenCalledTimes(1));
    const saved = saveMutateMock.mock.calls[0]?.[0] as RewriteRule;
    expect(saved.priority).toBe(20);
  });

  it("asks for confirmation before batch-deleting selected rules", async () => {
    rulesState.current = [
      makeRule({ id: "rule-a", name: "Alpha", priority: 200 }),
      makeRule({ id: "rule-b", name: "Beta", priority: 100 }),
    ];
    render(<RewriteRulesPanel />);

    fireEvent.click(screen.getAllByLabelText("rulesPage.batch.selectRule")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "rulesPage.batch.delete" }));

    // No deletion happens before the confirmation is accepted.
    expect(deleteRuleMock).not.toHaveBeenCalled();
    expect(screen.getByText("rulesPage.batch.deleteConfirmTitle")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "common.actions.delete" }));
    await waitFor(() => expect(deleteRuleMock).toHaveBeenCalledTimes(1));
    expect(deleteRuleMock).toHaveBeenCalledWith({ ruleId: "rule-a", ruleType: "rewrite" });
  });

  it("duplicates the current rule through the overflow menu", async () => {
    rulesState.current = [makeRule({ id: "rule-a", name: "Alpha", priority: 200 })];
    render(<RewriteRulesPanel />);

    await waitFor(() =>
      expect((screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement).value).toBe(
        "Alpha",
      ),
    );
    fireEvent.click(screen.getByLabelText("rulesPage.ruleActions"));
    fireEvent.click(screen.getByRole("menuitem", { name: /rulesPage\.duplicateRule/ }));

    await waitFor(() => {
      const field = screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement;
      expect(field.value).toBe("AlpharulesPage.copySuffix");
    });
  });

  it("fills the tester inputs from a picked session", async () => {
    sessionsState.current = [
      {
        id: "session-1",
        method: "POST",
        host: "api.example.com",
        path: "/v1/login",
        protocol: "http/1.1",
        startedAt: "2026-09-29T00:00:00Z",
        finishedAt: "2026-09-29T00:00:01Z",
        durationMs: 1000,
        sizeBytes: 128,
        statusCode: 200,
        url: "https://api.example.com/v1/login",
      },
    ];
    rulesState.current = [makeRule({ id: "rule-a", name: "Alpha", priority: 200 })];
    render(<RewriteRulesPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "rulesPage.rewrite.tester.pickFromSessions" }),
    );
    fireEvent.click(screen.getByText("api.example.com/v1/login"));

    await waitFor(() => {
      const urlField = screen.getByLabelText(
        /rulesPage\.rewrite\.tester\.sampleUrl/,
      ) as HTMLInputElement;
      expect(urlField.value).toBe("https://api.example.com/v1/login");
    });
  });
});

// ── P0-2 unsaved-changes guard: panel-level integration ─────────────────
//
// The hook tests cover the guard in isolation; these cover the wiring the
// review called out as regression-prone: forwardRef/isDirty, the imperative
// confirmLeave() the Rules page tab switch relies on, and the in-component
// rule-switch flow (dialog cancel keeps the draft, confirm discards it).
describe("RewriteRulesPanel — unsaved-changes guard integration (P0-2)", () => {
  function renderWithTwoRules() {
    rulesState.current = [
      makeRule({ id: "rule-a", name: "Alpha", priority: 200 }),
      makeRule({ id: "rule-b", name: "Beta", priority: 100 }),
    ];
    const panelRef = createRef<RewriteRulesPanelHandle>();
    render(<RewriteRulesPanel ref={panelRef} />);
    return panelRef;
  }

  async function editNameToDraft() {
    // The initial-selection effect lands on the highest-priority rule.
    const nameField = await waitFor(() => {
      const field = screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement;
      expect(field.value).toBe("Alpha");
      return field;
    });
    fireEvent.change(nameField, { target: { value: "Edited draft" } });
    return nameField;
  }

  it("flags dirtiness through the imperative handle while editing", async () => {
    const panelRef = renderWithTwoRules();
    await editNameToDraft();

    expect(panelRef.current?.isDirty).toBe(true);
  });

  it("cancel keeps the draft and the current selection", async () => {
    const panelRef = renderWithTwoRules();
    await editNameToDraft();

    fireEvent.click(screen.getByText("Beta"));
    expect(screen.getByText("rulesPage.unsavedChangesTitle")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "common.actions.keepEditing" }));
    });
    await waitFor(() =>
      expect(screen.queryByText("rulesPage.unsavedChangesTitle")).not.toBeInTheDocument(),
    );
    expect((screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement).value).toBe(
      "Edited draft",
    );
    expect(panelRef.current?.isDirty).toBe(true);
  });

  it("confirm discards the draft and loads the clicked rule", async () => {
    const panelRef = renderWithTwoRules();
    await editNameToDraft();

    fireEvent.click(screen.getByText("Beta"));
    expect(screen.getByText("rulesPage.unsavedChangesTitle")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "common.actions.discard" }));
    });
    await waitFor(() => {
      const field = screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement;
      expect(field.value).toBe("Beta");
      return field;
    });
    await waitFor(() =>
      expect(screen.queryByText("rulesPage.unsavedChangesTitle")).not.toBeInTheDocument(),
    );
    expect(panelRef.current?.isDirty).toBe(false);
  });

  it("resolves the imperative confirmLeave used by Rules-page tab switches", async () => {
    const panelRef = renderWithTwoRules();
    await editNameToDraft();

    // The page awaits this promise before unmounting the panel, so a wrong
    // resolution silently drops or traps the draft.
    let leavePromise!: Promise<boolean>;
    act(() => {
      leavePromise = panelRef.current!.confirmLeave();
    });
    expect(screen.getByText("rulesPage.unsavedChangesTitle")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "common.actions.keepEditing" }));
    });
    await expect(leavePromise).resolves.toBe(false);
    // MUI Dialog leaves the DOM node mounted through its exit transition.
    await waitFor(() =>
      expect(screen.queryByText("rulesPage.unsavedChangesTitle")).not.toBeInTheDocument(),
    );

    act(() => {
      leavePromise = panelRef.current!.confirmLeave();
    });
    expect(screen.getByText("rulesPage.unsavedChangesTitle")).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "common.actions.discard" }));
    });
    await expect(leavePromise).resolves.toBe(true);
    await waitFor(() =>
      expect(screen.queryByText("rulesPage.unsavedChangesTitle")).not.toBeInTheDocument(),
    );
  });
});

// ── P7: rewriteSeed consumption must go through the unsaved guard ────────
// A rewriteSeed (from "debug this request" on the sessions page) replaces the
// in-flight draft; previously the seed effect overwrote a dirty draft with no
// confirmation. Mirrors the mapLocalSeed guard in MapRulesPanel.
describe("RewriteRulesPanel — rewriteSeed unsaved guard", () => {
  const seed = {
    host: "seeded.example.com",
    method: "GET",
    path: "/x",
    url: "https://seeded.example.com/x",
  };

  async function renderDirtyDraftWithSeed() {
    rulesState.current = [makeRule({ id: "rule-a", name: "Alpha", priority: 200 })];
    const view = render(<RewriteRulesPanel />);

    // Wait for the initial selection to load, then make the draft dirty.
    const nameField = await waitFor(() => {
      const field = screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement;
      expect(field.value).toBe("Alpha");
      return field;
    });
    fireEvent.change(nameField, { target: { value: "Edited draft" } });

    // The seed arrives as a NEW history state after the draft is dirty.
    act(() => {
      routerState.current = { rewriteSeed: seed };
    });
    view.rerender(<RewriteRulesPanel />);
    return view;
  }

  it("vetoing the seed keeps the dirty draft and does not consume the seed", async () => {
    renderDirtyDraftWithSeed();

    await waitFor(() =>
      expect(screen.getByText("rulesPage.unsavedChangesTitle")).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "common.actions.keepEditing" }));
    });

    await waitFor(() =>
      expect(screen.queryByText("rulesPage.unsavedChangesTitle")).not.toBeInTheDocument(),
    );
    expect((screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement).value).toBe(
      "Edited draft",
    );
    // The seed stays in history state — navigate() must not have cleared it.
    expect(navigateMock).not.toHaveBeenCalledWith("/rules", { replace: true, state: null });
  });

  it("confirming the seed replaces the draft and clears the history state", async () => {
    renderDirtyDraftWithSeed();

    await waitFor(() =>
      expect(screen.getByText("rulesPage.unsavedChangesTitle")).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "common.actions.discard" }));
    });

    await waitFor(() => {
      const field = screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement;
      expect(field.value).toBe("Debug seeded.example.com");
    });
    expect(navigateMock).toHaveBeenCalledWith("/rules", { replace: true, state: null });
  });

  it("applies the seed immediately when the draft is not dirty", async () => {
    rulesState.current = [makeRule({ id: "rule-a", name: "Alpha", priority: 200 })];
    routerState.current = { rewriteSeed: seed };

    render(<RewriteRulesPanel />);

    await waitFor(() => {
      const field = screen.getByLabelText(/rulesPage\.editor\.ruleName/) as HTMLInputElement;
      expect(field.value).toBe("Debug seeded.example.com");
    });
    expect(screen.queryByText("rulesPage.unsavedChangesTitle")).not.toBeInTheDocument();
    expect(navigateMock).toHaveBeenCalledWith("/rules", { replace: true, state: null });
  });
});
