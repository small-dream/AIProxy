import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { ConfirmDialog } from "./ConfirmDialog";

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const props = {
    open: true,
    title: "Delete Rule",
    message: 'Delete "prod.example.com"? This action cannot be undone.',
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <AppProviders>
      <ConfirmDialog {...props} />
    </AppProviders>,
  );
  return { ...utils, props };
}

describe("ConfirmDialog", () => {
  it("renders title, message and default action labels when open", () => {
    renderDialog();

    expect(screen.getByText("Delete Rule")).toBeInTheDocument();
    expect(
      screen.getByText('Delete "prod.example.com"? This action cannot be undone.'),
    ).toBeInTheDocument();
    // Default labels come from common.actions.* (en via AppProviders).
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("renders nothing visible when closed", () => {
    renderDialog({ open: false });

    expect(screen.queryByText("Delete Rule")).not.toBeInTheDocument();
  });

  it("invokes onCancel on the cancel button and backdrop close request", () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("invokes onConfirm on the confirm button", () => {
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables both actions while confirming and honours custom labels", () => {
    renderDialog({
      confirmLabel: "Clear All",
      cancelLabel: "Dismiss",
      isConfirming: true,
    });

    const confirm = screen.getByRole("button", { name: "Clear All" }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement;
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();
  });

  it("omits the don't-ask-again checkbox by default", () => {
    renderDialog();

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders the opt-out checkbox and reports toggles when a label is given", () => {
    const onDontAskAgainChange = vi.fn();
    renderDialog({
      dontAskAgainLabel: "Clear sessions without asking again",
      dontAskAgainChecked: false,
      onDontAskAgainChange,
    });

    const checkbox = screen.getByRole("checkbox", {
      name: "Clear sessions without asking again",
    }) as HTMLInputElement;
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    expect(onDontAskAgainChange).toHaveBeenCalledTimes(1);
    expect(onDontAskAgainChange).toHaveBeenCalledWith(true);
  });

  it("disables the opt-out checkbox while confirming", () => {
    renderDialog({
      dontAskAgainLabel: "Clear sessions without asking again",
      isConfirming: true,
    });

    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
});
