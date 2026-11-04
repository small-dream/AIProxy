import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { AutomationChangedEvent } from "@aiproxy/shared-types";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAutomationEvents } from "./use-automation-events";

const eventMocks = vi.hoisted(() => ({
  handler: undefined as ((event: AutomationChangedEvent) => void) | undefined,
}));

vi.mock("@/services/events", () => ({
  onAutomationChanged: (handler: (event: AutomationChangedEvent) => void) => {
    eventMocks.handler = handler;
    return Promise.resolve(() => {});
  },
}));

describe("useAutomationEvents", () => {
  beforeEach(() => {
    eventMocks.handler = undefined;
  });

  it("invalidates rule, Agent Access, throttle, and change-set caches", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useAutomationEvents(), { wrapper });
    await waitFor(() => expect(eventMocks.handler).toBeTypeOf("function"));

    eventMocks.handler?.({
      reason: "apply_automation_plan",
      changeId: "change-1",
      changeIds: ["change-1"],
      runtimeGeneration: 4,
      scope: "workspace",
      workspaceId: "default",
      lifecycle: "persistent",
      status: "active",
      affectedResources: [{ kind: "rewrite", id: "rule-1", operation: "create" }],
      experimentId: null,
      cleanupState: null,
      timestamp: "2026-11-04T00:00:00Z",
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(12));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["rewrite-rules"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["map-rules"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agent-access-settings"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["automation-changes"] });
  });
});
