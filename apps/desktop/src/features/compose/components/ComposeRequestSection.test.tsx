import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { QueryParamsEditor } from "./ComposeRequestSection";

// QueryParamsEditor renders EditableKeyValueTable, which calls useI18n() for
// the add-button label and remove tooltip. A minimal mock keeps the test
// isolated from the i18n provider stack (matches EditableKeyValueTable.test).
vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// Mirrors how the parent uses the editor: the URL lives in a parent store and
// the editor writes back to it on every param change. Before the fix, that
// round trip re-derived params from `new URL(url)` on each keystroke, which
// (because URL encoding is non-idempotent) made the downstream table regenerate
// row ids and remount the focused input — so typing a value was impossible.
function ControlledEditor({ initialUrl }: { initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  return (
    <QueryParamsEditor
      namePlaceholder="Name"
      valuePlaceholder="Value"
      url={url}
      onUrlChange={setUrl}
    />
  );
}

// For the external-change test the URL is driven entirely from the prop (no
// local echo), so changing the prop exercises the editor's "re-parse on foreign
// URL change" path the same way a parent store swap does in production.
function ExternallyDrivenEditor({ url }: { url: string }) {
  return (
    <QueryParamsEditor
      namePlaceholder="Name"
      valuePlaceholder="Value"
      url={url}
      onUrlChange={vi.fn()}
    />
  );
}

function getValueInputs(): HTMLInputElement[] {
  // Each row has a name input then a value input, in DOM order. Value inputs are
  // the odd-indexed textboxes (1, 3, 5, ...).
  return screen
    .getAllByRole("textbox")
    .filter((_, i) => i % 2 === 1) as HTMLInputElement[];
}

describe("QueryParamsEditor — focus retention (H12)", () => {
  it("keeps focus on the value input while typing (URL round trip no longer remounts rows)", () => {
    render(<ControlledEditor initialUrl="https://example.com/api?foo=bar" />);

    const valueInput = getValueInputs()[0]!;
    expect(valueInput.value).toBe("bar");

    // Focus and type into the value field. Before the fix the second keystroke
    // would either throw focus off the input or visibly lose the cursor because
    // the row was re-mounted mid-edit.
    fireEvent.focus(valueInput);
    valueInput.focus();
    fireEvent.change(valueInput, { target: { value: "baz" } });

    // The DOM focus must still be on the SAME input element after the edit.
    expect(document.activeElement).toBe(valueInput);
    expect((document.activeElement as HTMLInputElement).value).toBe("baz");
  });

  it("preserves a value containing special characters across the URL round trip", () => {
    render(<ControlledEditor initialUrl="https://example.com/api?q=hello" />);

    const valueInput = getValueInputs()[0]!;
    valueInput.focus();
    // A space is the classic non-idempotent case: URLSearchParams encodes it to
    // "+", and re-parsing then decoding yields " " — but the old per-keystroke
    // re-derivation compared encoded vs decoded forms as different and remounted.
    fireEvent.change(valueInput, { target: { value: "hello world" } });

    expect(document.activeElement).toBe(valueInput);
    // The editor's local draft holds the raw value (focus/source of truth), not
    // the URL-encoded variant.
    expect((document.activeElement as HTMLInputElement).value).toBe("hello world");
  });

  it("still reflects external URL changes (a saved request loaded)", () => {
    const { rerender } = render(
      <ExternallyDrivenEditor url="https://example.com/api?foo=bar" />,
    );
    expect(getValueInputs()[0]!.value).toBe("bar");

    // Simulate the parent loading a different saved request — the URL prop
    // changes externally and the editor must re-parse and show the new params.
    rerender(<ExternallyDrivenEditor url="https://example.com/api?token=abc123" />);
    expect(getValueInputs()[0]!.value).toBe("abc123");
  });
});
