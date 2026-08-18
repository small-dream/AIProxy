import type { SessionSummary } from "@aiproxy/shared-types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { SaveResponseFilesDialog } from "./SaveResponseFilesDialog";

const saveResponseFiles = vi.hoisted(() => vi.fn());

// Partial mock: AppProviders pulls other commands (setMenuLocale, …) from the
// same barrel, so only the one under test is replaced.
vi.mock("@/services/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/commands")>()),
  saveResponseFiles,
}));

function createSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    durationMs: 42,
    finishedAt: "2026-04-11T10:00:03.000Z",
    host: "example.com",
    id: "session-1",
    method: "GET",
    path: "/",
    protocol: "HTTP/1.1",
    sizeBytes: 512,
    startedAt: "2026-04-11T10:00:00.000Z",
    statusCode: 200,
    url: "http://example.com/",
    ...overrides,
  };
}

function renderDialog(sessions: SessionSummary[], onCompleted = vi.fn(), onClose = vi.fn()) {
  render(
    <AppProviders>
      <SaveResponseFilesDialog
        onClose={onClose}
        onCompleted={onCompleted}
        open
        target={{ label: "static", sessions }}
      />
    </AppProviders>,
  );

  return { onClose, onCompleted };
}

describe("SaveResponseFilesDialog", () => {
  beforeEach(() => {
    saveResponseFiles.mockReset();
  });

  it("defaults to keeping only the latest capture of each file", async () => {
    saveResponseFiles.mockResolvedValue({
      directory: "/tmp/out",
      savedCount: 2,
      skippedCount: 0,
      failedCount: 0,
    });
    const { onCompleted, onClose } = renderDialog([
      createSessionSummary({ id: "a" }),
      createSessionSummary({ id: "b" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Choose Folder and Save" }));

    await waitFor(() => expect(saveResponseFiles).toHaveBeenCalled());
    expect(saveResponseFiles.mock.calls[0]?.[0]).toMatchObject({
      conflictStrategy: "latestOnly",
      sessionIds: ["a", "b"],
    });
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("passes the keep-all strategy when the user picks it", async () => {
    saveResponseFiles.mockResolvedValue({
      directory: "/tmp/out",
      savedCount: 2,
      skippedCount: 0,
      failedCount: 0,
    });
    renderDialog([createSessionSummary({ id: "a" })]);

    fireEvent.click(screen.getByRole("radio", { name: /Save every request/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose Folder and Save" }));

    await waitFor(() =>
      expect(saveResponseFiles.mock.calls[0]?.[0]).toMatchObject({
        conflictStrategy: "keepAll",
      }),
    );
  });

  it("excludes WebSocket sessions from the request count and payload", async () => {
    saveResponseFiles.mockResolvedValue({
      directory: "/tmp/out",
      savedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
    renderDialog([
      createSessionSummary({ id: "http" }),
      createSessionSummary({ id: "ws", protocol: "wss" }),
    ]);

    // Only the HTTP session is counted, so the user is not promised a file for
    // the WebSocket stream that the backend would skip anyway.
    expect(screen.getByText(/About to save 1 request\(s\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose Folder and Save" }));

    await waitFor(() =>
      expect(saveResponseFiles.mock.calls[0]?.[0]).toMatchObject({ sessionIds: ["http"] }),
    );
  });

  it("stays open when the user dismisses the directory picker", async () => {
    // A null result means the picker was cancelled — the chosen strategy must
    // not be thrown away.
    saveResponseFiles.mockResolvedValue(null);
    const { onCompleted, onClose } = renderDialog([createSessionSummary({ id: "a" })]);

    fireEvent.click(screen.getByRole("button", { name: "Choose Folder and Save" }));

    await waitFor(() => expect(saveResponseFiles).toHaveBeenCalled());
    expect(onCompleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces a failure without closing the dialog", async () => {
    // Production wrappers throw plain AppError objects (never `Error`
    // instances) — mock the real shape so the extraction path is the one
    // under test.
    saveResponseFiles.mockRejectedValue({
      code: "INTERNAL_ERROR",
      message: "disk is full",
    });
    const { onClose } = renderDialog([createSessionSummary({ id: "a" })]);

    fireEvent.click(screen.getByRole("button", { name: "Choose Folder and Save" }));

    expect(await screen.findByText("disk is full")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables saving when the folder holds nothing saveable", () => {
    renderDialog([createSessionSummary({ id: "ws", protocol: "wss" })]);

    expect(screen.getByRole("button", { name: "Choose Folder and Save" })).toBeDisabled();
  });
});
