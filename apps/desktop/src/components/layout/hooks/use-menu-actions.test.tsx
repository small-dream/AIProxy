import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMenuActions } from "./use-menu-actions";

// The hook registers a Tauri menu-event listener on mount; capture the handler
// so tests can drive it without a real backend.
const menuEventHandler: { current?: (payload: { menuId: string }) => void } = {};
vi.mock("@/services/events", () => ({
  onMenuEvent: (handler: (payload: { menuId: string }) => void) => {
    menuEventHandler.current = handler;
    return Promise.resolve(() => undefined);
  },
}));

vi.mock("@/services/commands", () => ({
  showLogFile: vi.fn(),
}));

vi.mock("@/features/updater/update-status", () => ({
  checkForUpdateAndStore: vi.fn(),
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, tList: (key: string) => [key], locale: "en-US" }),
}));

const onRequestClearAllSessions = vi.fn();
const navigate = vi.fn();

function setup() {
  const { result } = renderHook(() =>
    useMenuActions({
      navigate,
      proxyStatus: undefined,
      handleStartProxy: vi.fn(),
      handleStopProxy: vi.fn(),
      handleSystemProxyToggle: vi.fn(),
      handleAdbSetProxy: vi.fn(),
      handleAdbClearProxy: vi.fn(),
      runWindowCommand: vi.fn(),
      onSnackbarMessage: vi.fn(),
      onRequestClearAllSessions,
    }),
  );
  return result.current.handleMenuCommand;
}

beforeEach(() => {
  onRequestClearAllSessions.mockClear();
  navigate.mockClear();
});

describe("useMenuActions", () => {
  it("routes clear_all_sessions to the confirmation request instead of clearing directly", () => {
    const handleMenuCommand = setup();

    handleMenuCommand("clear_all_sessions");

    expect(onRequestClearAllSessions).toHaveBeenCalledTimes(1);
  });

  it("routes clear_sessions to the same confirmation request", () => {
    const handleMenuCommand = setup();

    handleMenuCommand("clear_sessions");

    expect(onRequestClearAllSessions).toHaveBeenCalledTimes(1);
  });

  it("still routes navigation commands to navigate", () => {
    const handleMenuCommand = setup();

    handleMenuCommand("goto_settings");

    expect(navigate).toHaveBeenCalledWith("/settings");
  });
});
