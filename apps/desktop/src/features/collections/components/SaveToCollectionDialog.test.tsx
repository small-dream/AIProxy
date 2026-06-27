import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { SaveToCollectionDialog } from "./SaveToCollectionDialog";

// M11: the dialog stays mounted (parent toggles `open`); the `name` input is
// initialized from `sessionName` ONCE via useState. Open for session A →
// cancel → open for session B → the input still showed A's name, so saving
// stored B under A's name. The fix syncs `name` to `sessionName` on change.

// Mock the collections query so the dialog renders without a real backend /
// TanStack Query network call. The dialog only reads `data`.
vi.mock("@/features/collections/use-collections", () => ({
  useCollections: () => ({ data: [] }),
  buildCollectionTree: () => [],
}));

describe("SaveToCollectionDialog (M11 name sync)", () => {
  it("updates the name input when sessionName changes between opens", () => {
    // Open for session A.
    const { rerender } = render(
      <AppProviders>
        <SaveToCollectionDialog
          open
          sessionName="Session A"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </AppProviders>,
    );

    // AppProviders supplies the real i18n; the field's label resolves to
    // "Request name" (en). MUI TextField links label↔input, so getByLabelText
    // finds the actual <input>.
    const input = screen.getByLabelText(/Request name/i) as HTMLInputElement;
    expect(input.value).toBe("Session A");

    // Close (parent keeps the dialog mounted, just hidden) then re-open for a
    // different session. sessionName is now "Session B".
    rerender(
      <AppProviders>
        <SaveToCollectionDialog
          open
          sessionName="Session B"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </AppProviders>,
    );

    // The input must reflect the CURRENT session, not the stale A value.
    const inputAfter = screen.getByLabelText(/Request name/i) as HTMLInputElement;
    expect(inputAfter.value).toBe("Session B");
  });
});
