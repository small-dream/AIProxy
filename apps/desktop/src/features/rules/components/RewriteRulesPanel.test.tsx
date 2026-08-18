import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RewriteRule } from "@aiproxy/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RewriteRulesPanel } from "./RewriteRulesPanel";

const rulesState: { current: RewriteRule[] } = { current: [] };
const saveMutateMock = vi.fn();
const deleteMutateMock = vi.fn();

vi.mock("@/features/rules/use-rule-center", () => ({
  useRewriteRules: () => ({ data: rulesState.current, isError: false }),
  useSaveRewriteRule: () => ({ mutate: saveMutateMock, isPending: false }),
  useDeleteManagedRule: () => ({ mutate: deleteMutateMock, isPending: false }),
}));

const routerState = vi.hoisted(() => ({ current: null as unknown }));
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/rules", state: routerState.current }),
  useNavigate: () => navigateMock,
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
});
