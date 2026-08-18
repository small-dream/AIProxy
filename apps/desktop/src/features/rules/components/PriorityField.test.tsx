import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { PriorityField } from "./PriorityField";

// Host with the same state shape the five rule editors use, so commits flow
// back through props exactly like in production.
function PriorityFieldHost({ initial }: { initial: number }) {
  const [priority, setPriority] = useState(initial);
  return <PriorityField value={priority} label="Priority" onCommit={setPriority} />;
}

describe("PriorityField", () => {
  it("commits valid input while typing", () => {
    const onCommit = vi.fn();
    render(
      <AppProviders>
        <PriorityField value={100} label="Priority" onCommit={onCommit} />
      </AppProviders>,
    );

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "250" } });

    expect(onCommit).toHaveBeenCalledWith(250);
  });

  it("holds an emptied field locally instead of snapping to 0 mid-edit (L3)", () => {
    const onCommit = vi.fn();
    render(
      <AppProviders>
        <PriorityField value={100} label="Priority" onCommit={onCommit} />
      </AppProviders>,
    );

    const field = screen.getByRole("spinbutton");
    fireEvent.change(field, { target: { value: "" } });

    expect(onCommit).not.toHaveBeenCalled();
    // jsdom reports a cleared number input as null, not "".
    expect(field).toHaveValue(null);
  });

  it("resolves to 0 on blur when the field is empty or invalid", () => {
    render(
      <AppProviders>
        <PriorityFieldHost initial={100} />
      </AppProviders>,
    );

    const field = screen.getByRole("spinbutton");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);

    expect(field).toHaveValue(0);

    fireEvent.change(field, { target: { value: "not-a-number" } });
    fireEvent.blur(field);

    expect(field).toHaveValue(0);
  });

  it("syncs back when the value changes externally", () => {
    render(
      <AppProviders>
        <PriorityFieldHost initial={100} />
      </AppProviders>,
    );

    const field = screen.getByRole("spinbutton");
    expect(field).toHaveValue(100);

    fireEvent.change(field, { target: { value: "7" } });
    expect(field).toHaveValue(7);
  });

  it("shows the precedence hint by default and hides it on demand", () => {
    const { rerender } = render(
      <AppProviders>
        <PriorityField value={1} label="Priority" onCommit={() => {}} />
      </AppProviders>,
    );

    expect(
      screen.getByText("Higher number = higher precedence. Drag rows in the list to reorder."),
    ).toBeInTheDocument();

    rerender(
      <AppProviders>
        <PriorityField value={1} label="Priority" onCommit={() => {}} showHint={false} />
      </AppProviders>,
    );

    expect(
      screen.queryByText("Higher number = higher precedence. Drag rows in the list to reorder."),
    ).not.toBeInTheDocument();
  });
});
