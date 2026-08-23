import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RewriteRule } from "@aiproxy/shared-types";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RewriteRulesPanel, type RewriteRulesPanelHandle } from "./RewriteRulesPanel";

const rulesState: { current: RewriteRule[] } = { current: [] };
const saveMutateMock = vi.fn();
const deleteMutateMock = vi.fn();

vi.mock("@/features/rules/use-rule-center", () => ({
  useRewriteRules: () => ({ data: rulesState.current, isError: false }),
  useSaveRewriteRule: () => ({ mutate: saveMutateMock, isPending: false }),
  useDeleteManagedRule: () => ({ mutate: deleteMutateMock, isPending: false }),
  useBulkUpdateRules: () => ({ mutate: vi.fn(), isPending: false }),
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
vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/rules", state: routerState.current }),
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
  saveMutateMock.mockClear();
  deleteMutateMock.mockClear();
  routerState.current = null;
});

describe("RewriteRulesPanel — multi-action rules (R1)", () => {
  it("saves a rule with multiple ordered actions", async () => {
    render(<RewriteRulesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.rewrite.types.header" }));
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

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.editor.saveRule" }));

    await waitFor(() => {
      expect(
        screen.getByText("rulesPage.rewrite.invalidCombination.queryRedirectOnResponse"),
      ).toBeInTheDocument();
    });
    expect(saveMutateMock).not.toHaveBeenCalled();
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
