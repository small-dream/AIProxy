import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationStore } from "@/services/notification.store";
import type { SystemProxyWarningPayload } from "@/services/events";

import { useSystemProxyWarning } from "./use-system-proxy-warning";

// The hook registers a Tauri `system-proxy-warning` listener on mount; capture
// the handler so tests can drive it without a real backend.
const warningHandler: { current?: (warning: SystemProxyWarningPayload) => void } = {};
const unlisten = vi.fn();
vi.mock("@/services/events", () => ({
  onSystemProxyWarning: (handler: (warning: SystemProxyWarningPayload) => void) => {
    warningHandler.current = handler;
    return Promise.resolve(unlisten);
  },
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
    locale: "en-US",
  }),
}));

beforeEach(() => {
  useNotificationStore.setState({ queue: [] });
  unlisten.mockClear();
});

describe("useSystemProxyWarning", () => {
  it("pushes a warning notification when the backend reports a reapply failure", () => {
    renderHook(() => useSystemProxyWarning());

    warningHandler.current?.({ reason: "reapply_failed", error: "networksetup failed" });

    const queue = useNotificationStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0]?.severity).toBe("warning");
    expect(queue[0]?.message).toContain("appShell.systemProxyReapplyWarning");
    expect(queue[0]?.message).toContain("networksetup failed");
  });

  it("releases the Tauri listener on unmount", async () => {
    const { unmount } = renderHook(() => useSystemProxyWarning());

    unmount();

    await waitFor(() => {
      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });
});
