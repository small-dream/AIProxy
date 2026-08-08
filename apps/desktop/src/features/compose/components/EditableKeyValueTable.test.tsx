import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditableKeyValueTable } from "./EditableKeyValueTable";

// The component only uses t() for an add-button label and a remove tooltip,
// so a minimal mock keeps this test isolated from the i18n provider stack.
vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function getRemoveButtons(): HTMLElement[] {
  return screen
    .getAllByRole("button")
    .filter((btn) => btn.getAttribute("aria-label") === "common.actions.remove");
}

function getNameInputValues(): string[] {
  // Each row renders two textboxes (name, value) in order. Names are the
  // even-indexed inputs (0, 2, 4, ...).
  return screen
    .getAllByRole("textbox")
    .filter((_, i) => i % 2 === 0)
    .map((input) => (input as HTMLInputElement).value);
}

describe("EditableKeyValueTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits the correct remaining entries when deleting a middle row (onChange)", () => {
    const onChange = vi.fn();
    const initial = [
      { name: "A", value: "a" },
      { name: "B", value: "b" },
      { name: "C", value: "c" },
    ];

    render(
      <EditableKeyValueTable
        items={initial}
        namePlaceholder="Name"
        valuePlaceholder="Value"
        onChange={onChange}
      />,
    );

    // Three rows => three remove buttons. Click the second to delete B/b.
    const removeButtons = getRemoveButtons();
    expect(removeButtons).toHaveLength(3);
    fireEvent.click(removeButtons[1]!);

    expect(onChange).toHaveBeenCalledTimes(1);
    // After deleting the middle row, the remaining entries must be A and C
    // (NOT A and B, which key={index} DOM reuse can produce).
    expect(onChange.mock.calls[0]![0]).toEqual([
      { name: "A", value: "a" },
      { name: "C", value: "c" },
    ]);
  });

  it("re-renders the correct values after a middle row is removed", () => {
    // This drives the actual DOM-reuse failure: with key={index}, React keeps
    // the first two row containers and updates their inputs from the new array,
    // so visible values can shuffle / focus jumps. With a stable key the B row
    // is unmounted and C shifts up correctly. We assert post-update DOM state.
    const initial = [
      { name: "A", value: "a" },
      { name: "B", value: "b" },
      { name: "C", value: "c" },
    ];

    function Harness() {
      const [items, setItems] = useState(initial);
      return (
        <EditableKeyValueTable
          items={items}
          namePlaceholder="Name"
          valuePlaceholder="Value"
          onChange={setItems}
        />
      );
    }

    render(<Harness />);

    fireEvent.click(getRemoveButtons()[1]!);

    // Remaining visible name inputs must be A and C.
    expect(getNameInputValues()).toEqual(["A", "C"]);
    expect(getRemoveButtons()).toHaveLength(2);
  });

  it("never leaks a local id into the emitted HeaderEntry[]", () => {
    const onChange = vi.fn();
    render(
      <EditableKeyValueTable
        items={[{ name: "X", value: "1" }]}
        namePlaceholder="Name"
        valuePlaceholder="Value"
        onChange={onChange}
      />,
    );

    // Trigger an add, then assert the emitted payload shape.
    const addButton = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent === "common.actions.add");
    fireEvent.click(addButton!);

    expect(onChange).toHaveBeenCalled();
    const emitted = onChange.mock.calls.at(-1)![0];
    // Every emitted entry must be a plain { name, value } — no `id` field,
    // so the shared HeaderEntry contract is preserved.
    expect(emitted).toEqual([
      { name: "X", value: "1" },
      { name: "", value: "" },
    ]);
    for (const entry of emitted) {
      expect(Object.keys(entry).sort()).toEqual(["name", "value"]);
    }
  });
});
