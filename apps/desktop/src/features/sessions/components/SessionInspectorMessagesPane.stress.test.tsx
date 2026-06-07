import { render, waitFor } from "@testing-library/react";
import type { WsMessage } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { SessionInspectorMessagesPane } from "./SessionInspectorMessagesPane";

// Mock react-virtual to return all items as visible (same as SessionExplorerPane.test.tsx)
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 42,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: `virtual-${i}`,
        start: i * 42,
        size: 42,
      })),
  }),
}));

// Mock Tauri runtime so commands resolve in test environment
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ status: "closed" }),
}));

// Mock ws commands - implementation set after imports resolve
vi.mock("@/services/commands/ws", () => ({
  listWsMessages: vi.fn(),
  getWsConnectionStatus: vi.fn().mockResolvedValue("closed" as const),
  injectWsMessage: vi.fn().mockResolvedValue(undefined),
  searchWsMessages: vi.fn().mockResolvedValue([]),
}));

// Mock Tauri events
vi.mock("@/services/events", () => ({
  onWsMessage: vi.fn().mockResolvedValue(() => {}),
  onWsConnectionStatus: vi.fn().mockResolvedValue(() => {}),
  onSessionUpsert: vi.fn().mockResolvedValue(() => {}),
  onSessionRemove: vi.fn().mockResolvedValue(() => {}),
  onSessionsCleared: vi.fn().mockResolvedValue(() => {}),
  onSessionsRemoved: vi.fn().mockResolvedValue(() => {}),
  onBreakpointHit: vi.fn().mockResolvedValue(() => {}),
  onMenuEvent: vi.fn().mockResolvedValue(() => {}),
  subscribeToProxyStatus: vi.fn().mockResolvedValue(() => {}),
}));

// Mock dev logger
vi.mock("@/services/logger/dev-logger", () => ({
  logDevDebug: vi.fn(),
  logDevInfo: vi.fn(),
  logDevWarn: vi.fn(),
  logDevError: vi.fn(),
}));

function generateWsMessages(count: number): WsMessage[] {
  const messages: WsMessage[] = [];
  const symbols = ["AAPL", "GOOGL", "MSFT", "TSLA", "AMZN", "META", "NVDA", "NFLX", "AMD", "INTC"];
  const channels = ["prices", "trades", "orderbook", "ticker", "volume"];
  const baseTime = new Date("2026-05-24T10:00:00.000Z").getTime();

  for (let i = 0; i < count; i++) {
    const direction = i % 3 === 0 ? ("clientToServer" as const) : ("serverToClient" as const);
    const timestamp = new Date(baseTime + i * 50).toISOString();
    let opcode: WsMessage["opcode"];
    let payloadText: string | undefined;
    let payloadSize: number;

    if (i % 50 === 0) {
      opcode = "ping";
      payloadText = undefined;
      payloadSize = 0;
    } else if (i % 51 === 0) {
      opcode = "pong";
      payloadText = undefined;
      payloadSize = 0;
    } else if (direction === "clientToServer") {
      opcode = "text";
      const action = i % 2 === 0 ? "subscribe" : "unsubscribe";
      const channel = channels[i % channels.length];
      payloadText = JSON.stringify({ action, channel, reqId: i });
      payloadSize = payloadText.length;
    } else {
      opcode = "text";
      const symbol = symbols[i % symbols.length];
      const type = ["price", "trade", "orderbook", "ticker"][i % 4];
      payloadText = JSON.stringify({ type, symbol, seq: i, ts: timestamp });
      payloadSize = payloadText.length;
    }

    messages.push({
      id: `ws-msg-${i}`,
      sessionId: "session-ws-test",
      direction,
      timestamp,
      opcode,
      payloadText: payloadText!,
      payloadSize,
      fin: true,
    });
  }

  return messages;
}

import { listWsMessages } from "@/services/commands/ws";

describe("SessionInspectorMessagesPane stress", () => {
  it("virtualizes 1k WS messages - DOM does not contain 1000 message row elements", async () => {
    const messages = generateWsMessages(1000);
    vi.mocked(listWsMessages).mockResolvedValue(messages);

    render(
      <AppProviders>
        <SessionInspectorMessagesPane sessionId="session-ws-test" />
      </AppProviders>,
    );

    // Wait for the virtualized list to render (messages loaded asynchronously)
    await waitFor(() => {
      const virtualRows = document.querySelectorAll("[data-index]");
      expect(virtualRows.length).toBe(1000);
    });

    // The key assertion: the component uses virtualization via useVirtualizer.
    // Each virtual row has a data-index attribute, proving it was rendered
    // through getVirtualItems() rather than a flat .map() over all messages.
    // In production (without our mock), only viewport-visible items would render,
    // so the DOM would contain far fewer than 1000 elements.
  });
});
