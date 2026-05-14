import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { SessionContextMenu } from "./SessionContextMenu";

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 48,
    finishedAt: "2026-04-21T10:00:03.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "GET",
    path: "/users",
    protocol: "https",
    responseMimeType: "application/json",
    sizeBytes: 512,
    startedAt: "2026-04-21T10:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/users",
    ...overrides,
  };
}

describe("SessionContextMenu", () => {
  it("offers exporting the selected request", () => {
    const handleExportSession = vi.fn();
    const session = createSessionSummary();

    render(
      <AppProviders>
        <SessionContextMenu
          anchorPosition={{ left: 20, top: 20 }}
          isHostFocused={false}
          isHostIgnored={false}
      onClearOthers={vi.fn()}
      onClose={vi.fn()}
      onCompose={vi.fn()}
      onCompareWith={vi.fn()}
      onCopyCurl={vi.fn()}
          onCopyRequest={vi.fn()}
          onCopyResponse={vi.fn()}
          onCopyUrl={vi.fn()}
          onCreateRewrite={vi.fn()}
          onCreateThrottleRule={vi.fn()}
          onExportSession={handleExportSession}
          onFocusHost={vi.fn()}
          onGoToBreakpoints={vi.fn()}
          onGoToRules={vi.fn()}
          onIgnoreHost={vi.fn()}
          onRepeat={vi.fn()}
      onSaveResponse={vi.fn()}
      onSaveToCollection={vi.fn()}
      onSetCompareBase={vi.fn()}
          onStopIgnoringHost={vi.fn()}
          onUnfocusHost={vi.fn()}
          session={session}
        />
      </AppProviders>,
    );

    fireEvent.click(screen.getByText("Export Request"));

    expect(handleExportSession).toHaveBeenCalledWith(session);
  });
});
