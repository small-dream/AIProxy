import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MapRule } from "@aiproxy/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MapRulesPanel } from "./MapRulesPanel";

// --- Controllable mock fixtures -------------------------------------------
// The auto-select effect depends on the `rules` array identity returned by the
// query hook, so we drive it through a module-level mutable holder exactly the
// way use-throttle-editor.test.tsx does.
const rulesState: { current: MapRule[] } = { current: [] };
// Module-level so the delete-confirmation tests can assert on it.
const deleteMutateMock = vi.fn();

vi.mock("@/features/rules/use-rule-center", () => ({
  useMapRules: () => ({ data: rulesState.current, isError: false }),
  useSaveMapRule: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteManagedRule: () => ({ mutate: deleteMutateMock, isPending: false }),
}));

// The panel imports the Tauri dialog plugin at module top level for the file
// picker; it is never invoked during this test (we never click the picker), but
// the bare import pulls in @tauri-apps/api/core which has no jsdom runtime, so
// stub the plugin to keep the test hermetic.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// The panel reads location state for the "Map Local from session" seed flow;
// the tests exercise the panel in isolation without a router. The state holder
// lets the seed test drive what useLocation returns.
const routerState = vi.hoisted(() => ({ current: null as unknown }));
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/rules", state: routerState.current }),
  // Stable reference: the seed effect depends on `navigate`, and a fresh
  // function identity per render would re-trigger it forever.
  useNavigate: () => navigateMock,
}));

// Keep the test free of the i18n provider dependency.
vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, tList: (key: string) => [key], locale: "en-US" }),
}));

function makeRule(overrides: Partial<MapRule> = {}): MapRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: "default",
    mode: "remote",
    name: "",
    enabled: true,
    priority: 100,
    sourcePattern: "",
    targetValue: "",
    preservePath: true,
    preserveQuery: true,
    note: "",
    ...overrides,
  };
}

beforeEach(() => {
  rulesState.current = [];
  deleteMutateMock.mockClear();
  routerState.current = null;
});

describe("MapRulesPanel — Map Local seed from a captured request", () => {
  it("pre-fills source pattern and name from the mapLocalSeed", async () => {
    routerState.current = {
      mapLocalSeed: {
        host: "api.example.com",
        method: "GET",
        path: "/users",
        url: "https://api.example.com/users",
      },
    };

    render(<MapRulesPanel mode="local" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/rulesPage\.mapEditor\.sourcePattern/)).toHaveValue(
        "api.example.com/users",
      );
    });
    expect(screen.getByLabelText(/rulesPage\.editor\.ruleName/)).toHaveValue(
      "Map Local api.example.com",
    );
  });
});

describe("MapRulesPanel — newly-created rule selection (M10)", () => {
  it("keeps the freshly-created draft selected instead of snapping back to an existing rule", () => {
    // Seed two existing saved rules. Without the fix, clicking "Create Rule"
    // sets selectedRuleId to the new draft id, but the auto-select effect then
    // sees that id is absent from `rules`, does NOT early-return, and overwrites
    // both selection and draft with filteredRules[0] — snapping back to rule A.
    const ruleA = makeRule({ id: "rule-a", name: "Rule A", priority: 200 });
    const ruleB = makeRule({ id: "rule-b", name: "Rule B", priority: 100 });
    rulesState.current = [ruleA, ruleB];

    render(<MapRulesPanel mode="remote" />);

    // Sanity: initially the highest-priority rule (Rule A) is selected and its
    // name populates the editor's rule-name field.
    expect(screen.getByDisplayValue("Rule A")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.mapRemote.createRule" }));

    // After the fix, the new empty draft stays selected: the editor's rule-name
    // field is cleared (new empty draft) instead of snapping back to "Rule A".
    expect(screen.queryByDisplayValue("Rule A")).not.toBeInTheDocument();
    // The editor should now show an empty rule-name input (the new draft).
    const nameField = screen.getByLabelText(/rulesPage\.editor\.ruleName/i) as HTMLInputElement;
    expect(nameField.value).toBe("");
  });

  it("keeps the new draft selected even when there are no existing rules", () => {
    // With an empty rule list, the pre-fix auto-select effect fell through to
    // setSelectedRuleId(undefined), dropping the freshly-created selection.
    rulesState.current = [];

    render(<MapRulesPanel mode="remote" />);

    // No rules means the empty-state copy is shown.
    expect(screen.getByText("rulesPage.mapRemote.emptyDescription")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "rulesPage.mapRemote.createRule" }));

    // The editor must reflect the new draft — the name input renders empty and
    // is editable, proving the draft was not reset by the auto-select effect.
    const nameField = screen.getByLabelText(/rulesPage\.editor\.ruleName/i) as HTMLInputElement;
    expect(nameField.value).toBe("");

    // And editing the new draft must stick (not be clobbered by the effect).
    fireEvent.change(nameField, { target: { value: "New Draft" } });
    expect((screen.getByLabelText(/rulesPage\.editor\.ruleName/i) as HTMLInputElement).value).toBe(
      "New Draft",
    );
  });
});

describe("MapRulesPanel — delete confirmation (P0-2)", () => {
  it("requires confirmation before the persisted rule is deleted", () => {
    rulesState.current = [makeRule({ id: "rule-a", name: "Rule A" })];

    render(<MapRulesPanel mode="remote" />);

    // Clicking the editor's remove button must NOT delete immediately...
    fireEvent.click(screen.getByRole("button", { name: "common.actions.remove" }));
    expect(deleteMutateMock).not.toHaveBeenCalled();

    // ...but open the confirmation dialog first.
    expect(screen.getByText("rulesPage.deleteRuleTitle")).toBeInTheDocument();
    expect(screen.getByText("common.confirmDeleteMessage")).toBeInTheDocument();

    // Confirming performs the delete with the selected rule id.
    fireEvent.click(screen.getByRole("button", { name: "common.actions.delete" }));
    expect(deleteMutateMock).toHaveBeenCalledWith(
      { ruleId: "rule-a", ruleType: "map" },
      expect.anything(),
    );
  });

  it("cancelling the dialog keeps the rule", () => {
    rulesState.current = [makeRule({ id: "rule-a", name: "Rule A" })];

    render(<MapRulesPanel mode="remote" />);

    fireEvent.click(screen.getByRole("button", { name: "common.actions.remove" }));
    fireEvent.click(screen.getByRole("button", { name: "common.actions.cancel" }));

    // The rule must survive cancelling. (The dialog's exit animation never
    // completes in jsdom, so asserting its removal is not reliable.)
    expect(deleteMutateMock).not.toHaveBeenCalled();
  });
});
