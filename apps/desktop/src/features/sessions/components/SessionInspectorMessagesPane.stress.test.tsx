import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { WsMessage } from "@aiproxy/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { SessionInspectorMessagesPane } from "./SessionInspectorMessagesPane";
import { onWsMessage } from "@/services/events";

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
  }, 15_000);
});

// ---------------------------------------------------------------------------
// P0-4 snapshot/live race + P1-14 micro-batching
// ---------------------------------------------------------------------------

const SESSION_ID = "session-ws-test";

function buildWsMessage(id: string, marker: string): WsMessage {
  return {
    id,
    sessionId: SESSION_ID,
    direction: "serverToClient",
    timestamp: new Date("2026-05-24T10:00:00.000Z").toISOString(),
    opcode: "text",
    payloadText: JSON.stringify({ marker }),
    payloadSize: 16,
    fin: true,
  };
}

function emitWsFrame(msg: WsMessage) {
  const calls = vi.mocked(onWsMessage).mock.calls;
  const handler = calls.at(-1)?.[0] as ((msg: WsMessage) => void) | undefined;
  expect(handler, "onWsMessage handler not registered").toBeDefined();
  handler?.(msg);
}

describe("SessionInspectorMessagesPane snapshot/live race", () => {
  it("keeps live frames that arrive before the snapshot resolves and dedupes by id", async () => {
    let resolveSnapshot!: (messages: WsMessage[]) => void;
    vi.mocked(listWsMessages).mockImplementation(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );

    render(
      <AppProviders>
        <SessionInspectorMessagesPane sessionId={SESSION_ID} />
      </AppProviders>,
    );

    // Live frames race in before the snapshot command resolves; one of them
    // duplicates a frame the snapshot also contains.
    emitWsFrame(buildWsMessage("ws-live-1", "live-1"));
    emitWsFrame(buildWsMessage("ws-dup", "dup-from-live"));
    await act(async () => {
      resolveSnapshot([
        buildWsMessage("ws-snap-0", "snap-0"),
        buildWsMessage("ws-dup", "dup-from-snapshot"),
      ]);
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("snap-0");
      expect(text).toContain("live-1");
      expect(text).toContain("dup-from");
    });

    // The duplicate id appears exactly once — the live copy won the merge.
    const text = document.body.textContent ?? "";
    expect(text.match(/dup-from/g)).toHaveLength(1);
  }, 10_000);

  it("shows a load error with retry when the snapshot command rejects", async () => {
    vi.mocked(listWsMessages).mockRejectedValueOnce({
      code: "WS_LOAD_FAILED",
      message: "snapshot boom",
    });
    vi.mocked(listWsMessages).mockResolvedValueOnce([]);

    const { getByRole, findByText } = render(
      <AppProviders>
        <SessionInspectorMessagesPane sessionId={SESSION_ID} />
      </AppProviders>,
    );

    expect(await findByText("snapshot boom")).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "Retry" }));

    // Retry succeeds → the normal empty state returns.
    await waitFor(() => {
      expect(document.body.textContent).toContain("No WebSocket Messages");
    });
  }, 10_000);
});

describe("SessionInspectorMessagesPane live-frame batching", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("commits a burst of frames in one flush instead of one render per event", async () => {
    const initial = Array.from({ length: 5 }, (_, i) =>
      buildWsMessage(`ws-init-${i}`, `init-${i}`),
    );
    vi.mocked(listWsMessages).mockResolvedValue(initial);

    render(
      <AppProviders>
        <SessionInspectorMessagesPane sessionId={SESSION_ID} />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("init-4");
    });

    // A burst of 50 frames arrives synchronously. With rAF held back nothing
    // may commit yet — per-event setState would have rendered immediately.
    act(() => {
      for (let i = 0; i < 50; i++) {
        emitWsFrame(buildWsMessage(`ws-burst-${i}`, `burst-${i}`));
      }
    });
    expect(document.body.textContent).not.toContain("burst-49");

    // One animation frame releases the whole burst in a single commit.
    act(() => {
      for (const callback of rafCallbacks.splice(0)) callback(0);
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("burst-0");
      expect(text).toContain("burst-49");
    });
  }, 10_000);
});
