import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ThrottleProfile, ThrottleRule } from "@aiproxy/shared-types";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { RuleEditor } from "./RuleEditor";

// RuleEditor is fully prop-driven (the consumer passes `t`): a passthrough
// `t(key)` lets assertions read keys back. The i18n provider is only needed
// because the shared PriorityField reads its hint from rulesPage.priorityHint.
function makeT() {
  return (key: string) => key;
}

function makeProfile(overrides: Partial<ThrottleProfile> = {}): ThrottleProfile {
  return {
    downloadKbps: 0,
    enabled: true,
    id: "profile-1",
    latencyMs: 0,
    name: "Default",
    packetLossRatio: 0,
    preset: false,
    uploadKbps: 0,
    workspaceId: "default",
    ...overrides,
  };
}

function makeRule(overrides: Partial<ThrottleRule> = {}): ThrottleRule {
  return {
    enabled: true,
    id: "rule-1",
    methods: [],
    name: "Rule 1",
    priority: 100,
    profileId: "profile-1",
    stage: "both",
    urlPattern: "example.com",
    workspaceId: "default",
    ...overrides,
  };
}

describe("RuleEditor methods field (H13)", () => {
  // RuleEditor is a controlled component, so a stateful wrapper is needed to
  // exercise multi-select accumulation (each selection must build on the last).
  function renderStateful(initial: ThrottleRule) {
    const onChange = vi.fn();
    function Harness() {
      const [draft, setDraft] = useState<ThrottleRule>(initial);
      return (
        <RuleEditor
          draft={draft}
          errors={{}}
          profiles={[makeProfile()]}
          t={makeT()}
          onChange={(patch) => {
            onChange(patch);
            setDraft((previous) => ({ ...previous, ...patch }));
          }}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          onSave={vi.fn()}
          saving={false}
          validationAttempted={false}
        />
      );
    }
    const utils = render(
      <AppProviders>
        <Harness />
      </AppProviders>,
    );
    return { ...utils, onChange };
  }

  it("lets the user select multiple HTTP methods without losing earlier ones", async () => {
    const { onChange } = renderStateful(makeRule({ methods: [] }));

    // There are several MUI Selects on the page; target the methods one. When
    // empty it renders the "all methods" hint in its display area, so find that
    // text and click the surrounding select trigger. Before the fix this was a
    // TextField where typing "GET, " re-parsed to ["GET"] on every keystroke,
    // so the second method could never be entered.
    const display = screen.getByText("rulesPage.allMethods");
    const trigger = display.closest(".MuiSelect-select") as HTMLElement;
    fireEvent.mouseDown(trigger);

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "GET" })).toBeInTheDocument();
    });

    // Select two methods one at a time.
    fireEvent.click(screen.getByRole("option", { name: "GET" }));
    fireEvent.click(screen.getByRole("option", { name: "POST" }));

    // onChange fires once per selection; the latest call must carry BOTH methods.
    expect(onChange).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith({ methods: ["GET", "POST"] });
  });

  it("renders the all-methods hint when nothing is selected", () => {
    render(
      <AppProviders>
        <RuleEditor
          draft={makeRule({ methods: [] })}
          errors={{}}
          profiles={[makeProfile()]}
          t={makeT()}
          onChange={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          onSave={vi.fn()}
          saving={false}
          validationAttempted={false}
        />
      </AppProviders>,
    );

    expect(screen.getByText("rulesPage.allMethods")).toBeInTheDocument();
  });

  it("renders the selected methods joined for an existing rule", () => {
    render(
      <AppProviders>
        <RuleEditor
          draft={makeRule({ methods: ["PUT", "DELETE"] })}
          errors={{}}
          profiles={[makeProfile()]}
          t={makeT()}
          onChange={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          onSave={vi.fn()}
          saving={false}
          validationAttempted={false}
        />
      </AppProviders>,
    );

    expect(screen.getByText("PUT, DELETE")).toBeInTheDocument();
  });
});
