import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AgentControlActionEvent } from "@aiproxy/shared-types";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationStore } from "@/services/notification.store";

import { useAgentControlEvents } from "./use-agent-control-events";

const eventMocks = vi.hoisted(() => ({
  handler: undefined as ((event: AgentControlActionEvent) => void) | undefined,
  listenRejects: false,
  recentEvents: [] as AgentControlActionEvent[],
}));

vi.mock("@/services/events", () => ({
  onAgentControlAction: (handler: (event: AgentControlActionEvent) => void) => {
    if (eventMocks.listenRejects) {
      return Promise.reject(new Error("listener unavailable"));
    }
    eventMocks.handler = handler;
    return Promise.resolve(() => {});
  },
}));

vi.mock("@/services/commands", () => ({
  getRecentAgentControlActions: () => Promise.resolve(eventMocks.recentEvents),
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      `${key}:${params?.action ?? ""}${params?.code ? `:${params.code}` : ""}`,
  }),
}));

describe("useAgentControlEvents", () => {
  beforeEach(() => {
    eventMocks.handler = undefined;
    eventMocks.listenRejects = false;
    eventMocks.recentEvents = [];
    window.sessionStorage.clear();
    useNotificationStore.setState({ queue: [] });
  });

  it("refreshes agent-controlled data and shows a completion notification", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useAgentControlEvents(), { wrapper });
    await waitFor(() => expect(eventMocks.handler).toBeTypeOf("function"));

    act(() => {
      eventMocks.handler?.({
        eventId: "event-1",
        timestamp: "2026-10-26T00:00:00Z",
        actionSummary: "Start capture for workspace default",
        durationMs: 12,
        errorCode: null,
        method: "startCapture",
        ok: true,
      });
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4));
    expect(useNotificationStore.getState().queue[0]).toMatchObject({
      message: "appShell.agentControlActionSuccess:appShell.agentControlStartCapture:",
      severity: "success",
    });
  });

  it("reports control errors with their error code", async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useAgentControlEvents(), { wrapper });
    await waitFor(() => expect(eventMocks.handler).toBeTypeOf("function"));

    act(() => {
      eventMocks.handler?.({
        eventId: "event-2",
        timestamp: "2026-10-26T00:00:01Z",
        actionSummary: "Set system proxy enabled=true",
        durationMs: 20,
        errorCode: "CONTROL_PERMISSION_DENIED",
        method: "setSystemProxy",
        ok: false,
      });
    });

    await waitFor(() => expect(useNotificationStore.getState().queue).toHaveLength(1));
    expect(useNotificationStore.getState().queue[0]).toMatchObject({
      message:
        "appShell.agentControlActionFailure:appShell.agentControlSetSystemProxy::CONTROL_PERMISSION_DENIED",
      severity: "error",
    });
  });

  it("replays an action that completed before the renderer mounted", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    eventMocks.recentEvents = [
      {
        eventId: "replayed-event",
        timestamp: "2026-10-26T00:00:00Z",
        actionSummary: "Generate root certificate",
        durationMs: 15,
        errorCode: null,
        method: "generateCertificate",
        ok: true,
      },
    ];
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useAgentControlEvents(), { wrapper });

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4));
    expect(useNotificationStore.getState().queue[0]?.message).toContain(
      "appShell.agentControlGenerateCertificate",
    );
  });

  it("does not show a replayed event twice when the live event arrives too", async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const event: AgentControlActionEvent = {
      eventId: "duplicate-event",
      timestamp: "2026-10-26T00:00:00Z",
      actionSummary: "Start capture",
      durationMs: 12,
      errorCode: null,
      method: "startCapture",
      ok: true,
    };
    eventMocks.recentEvents = [event];
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useAgentControlEvents(), { wrapper });
    await waitFor(() => expect(eventMocks.handler).toBeTypeOf("function"));

    act(() => {
      eventMocks.handler?.(event);
    });

    await waitFor(() => expect(useNotificationStore.getState().queue).toHaveLength(1));
  });

  it("still replays a completed action when live registration fails", async () => {
    eventMocks.listenRejects = true;
    eventMocks.recentEvents = [
      {
        eventId: "replay-without-listener",
        timestamp: "2026-10-26T00:00:00Z",
        actionSummary: "Start capture",
        durationMs: 12,
        errorCode: null,
        method: "startCapture",
        ok: true,
      },
    ];
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useAgentControlEvents(), { wrapper });

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4));
    expect(useNotificationStore.getState().queue[0]?.message).toContain(
      "appShell.agentControlStartCapture",
    );
  });
});
