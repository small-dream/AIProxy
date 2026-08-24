import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAdbActions } from "./use-adb-actions";

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

vi.mock("@/services/commands", () => ({
  listAndroidAdbDevices: vi.fn(),
  getLocalIp: vi.fn(),
  setAndroidProxyViaAdb: vi.fn(),
  clearAndroidProxyViaAdb: vi.fn(),
}));

import {
  clearAndroidProxyViaAdb,
  getLocalIp,
  listAndroidAdbDevices,
  setAndroidProxyViaAdb,
} from "@/services/commands";

const listDevicesMock = vi.mocked(listAndroidAdbDevices);
const getLocalIpMock = vi.mocked(getLocalIp);
const setProxyMock = vi.mocked(setAndroidProxyViaAdb);
const clearProxyMock = vi.mocked(clearAndroidProxyViaAdb);

function setup({ running = true }: { running?: boolean } = {}) {
  const onSnackbarMessage = vi.fn();
  const onMultipleDevices = vi.fn();
  const { result } = renderHook(() =>
    useAdbActions({
      port: 9090,
      proxyStatus: { running },
      onSnackbarMessage,
      onMultipleDevices,
    }),
  );
  return { result, onSnackbarMessage, onMultipleDevices };
}

beforeEach(() => {
  vi.clearAllMocks();
  getLocalIpMock.mockResolvedValue(["192.168.1.10"]);
  setProxyMock.mockResolvedValue({
    success: true,
    deviceSerial: "R58M2",
    proxyAddress: "192.168.1.10:9090",
  });
  clearProxyMock.mockResolvedValue({ success: true, deviceSerial: "R58M2" });
});

describe("useAdbActions", () => {
  it("runs the proxy set immediately for a single device", async () => {
    listDevicesMock.mockResolvedValue([{ serial: "R58M2", state: "device", model: "Pixel 8" }]);
    const { result, onMultipleDevices, onSnackbarMessage } = setup();

    await act(async () => {
      await result.current.handleAdbSetProxy();
    });

    expect(onMultipleDevices).not.toHaveBeenCalled();
    expect(setProxyMock).toHaveBeenCalledWith({
      deviceSerial: "R58M2",
      host: "192.168.1.10",
      port: 9090,
    });
    expect(onSnackbarMessage).toHaveBeenCalled();
  });

  it("opens the device picker with the set action when several devices are present", async () => {
    listDevicesMock.mockResolvedValue([
      { serial: "R58M2", state: "device", model: "Pixel 8" },
      { serial: "emulator-5554", state: "device", model: "Emulator" },
    ]);
    const { result, onMultipleDevices } = setup();

    await act(async () => {
      await result.current.handleAdbSetProxy();
    });

    expect(onMultipleDevices).toHaveBeenCalledWith("set");
    expect(setProxyMock).not.toHaveBeenCalled();
  });

  it("opens the device picker with the clear action when several devices are present", async () => {
    listDevicesMock.mockResolvedValue([
      { serial: "R58M2", state: "device" },
      { serial: "emulator-5554", state: "device" },
    ]);
    const { result, onMultipleDevices } = setup();

    await act(async () => {
      await result.current.handleAdbClearProxy();
    });

    expect(onMultipleDevices).toHaveBeenCalledWith("clear");
    expect(clearProxyMock).not.toHaveBeenCalled();
  });

  it("fails immediately when the proxy is not running, even with several devices", async () => {
    listDevicesMock.mockResolvedValue([
      { serial: "R58M2", state: "device", model: "Pixel 8" },
      { serial: "emulator-5554", state: "device", model: "Emulator" },
    ]);
    const { result, onMultipleDevices, onSnackbarMessage } = setup({ running: false });

    await act(async () => {
      await result.current.handleAdbSetProxy();
    });

    expect(onMultipleDevices).not.toHaveBeenCalled();
    expect(setProxyMock).not.toHaveBeenCalled();
    expect(onSnackbarMessage).toHaveBeenCalledWith(
      "certificatesPage.mobile.adbProxyRequiresRunningProxy",
    );
  });

  it("reports a missing-device error and does not open the picker", async () => {
    listDevicesMock.mockResolvedValue([]);
    const { result, onMultipleDevices, onSnackbarMessage } = setup();

    await act(async () => {
      await result.current.handleAdbSetProxy();
    });

    expect(onMultipleDevices).not.toHaveBeenCalled();
    expect(onSnackbarMessage).toHaveBeenCalled();
  });

  it("sets the proxy on the device chosen in the picker", async () => {
    const { result, onSnackbarMessage } = setup();

    let ok = false;
    await act(async () => {
      ok = await result.current.handleAdbProxyForDevice("set", "R58M2");
    });

    expect(ok).toBe(true);
    expect(setProxyMock).toHaveBeenCalledWith({
      deviceSerial: "R58M2",
      host: "192.168.1.10",
      port: 9090,
    });
    expect(onSnackbarMessage).toHaveBeenCalled();
  });

  it("clears the proxy on the device chosen in the picker", async () => {
    const { result, onSnackbarMessage } = setup();

    let ok = false;
    await act(async () => {
      ok = await result.current.handleAdbProxyForDevice("clear", "R58M2");
    });

    expect(ok).toBe(true);
    expect(clearProxyMock).toHaveBeenCalledWith({ deviceSerial: "R58M2" });
    expect(onSnackbarMessage).toHaveBeenCalled();
  });

  it("fails the picker set action when the proxy is not running", async () => {
    const { result, onSnackbarMessage } = setup({ running: false });

    let ok = true;
    await act(async () => {
      ok = await result.current.handleAdbProxyForDevice("set", "R58M2");
    });

    expect(ok).toBe(false);
    expect(setProxyMock).not.toHaveBeenCalled();
    expect(onSnackbarMessage).toHaveBeenCalled();
    await waitFor(() => expect(result.current.adbMenuActionPending).toBe(false));
  });
});
