import { useState } from "react";

import { useI18n } from "@/i18n";
import {
  clearAndroidProxyViaAdb,
  getLocalIp,
  listAndroidAdbDevices,
  setAndroidProxyViaAdb,
} from "@/services/commands";

import { getErrorMessage } from "./helpers";

interface ProxyStatusLike {
  running?: boolean;
}

/** ADB proxy actions exposed from the quick menu; picked up by the device picker. */
export type AdbProxyAction = "set" | "clear";

interface UseAdbActionsParams {
  port: number;
  proxyStatus: ProxyStatusLike | undefined;
  onSnackbarMessage: (message: string | null) => void;
  /** Invoked when more than one device is present; the caller opens a device picker. */
  onMultipleDevices: (action: AdbProxyAction) => void;
}

/**
 * Manages ADB device proxy set/clear actions with loading state.
 *
 * Single-device flows run immediately; when several devices are connected the
 * caller shows a picker dialog and then calls `handleAdbProxyForDevice` with
 * the chosen serial.
 */
export function useAdbActions({
  port,
  proxyStatus,
  onMultipleDevices,
  onSnackbarMessage,
}: UseAdbActionsParams) {
  const { t } = useI18n();
  const [adbMenuActionPending, setAdbMenuActionPending] = useState(false);

  /**
   * Runs the selected action against a concrete device; resolves `true` on
   * success. Reused by both the single-device quick-menu path (which already
   * owns the pending state) and the multi-device picker dialog.
   */
  async function handleAdbProxyForDevice(
    action: AdbProxyAction,
    deviceSerial: string,
  ): Promise<boolean> {
    setAdbMenuActionPending(true);

    try {
      if (action === "set") {
        if (!proxyStatus?.running) {
          throw new Error(t("certificatesPage.mobile.adbProxyRequiresRunningProxy"));
        }

        const localIps = await getLocalIp();
        const localIp = localIps[0];

        if (!localIp) {
          throw new Error(t("certificatesPage.mobile.adbProxyRequiresLocalIp"));
        }

        const result = await setAndroidProxyViaAdb({
          deviceSerial,
          host: localIp,
          port,
        });

        onSnackbarMessage(
          t("certificatesPage.mobile.adbSetProxySuccessBody", {
            deviceSerial: result.deviceSerial,
            proxyAddress: result.proxyAddress ?? `${localIp}:${port}`,
          }),
        );
      } else {
        const result = await clearAndroidProxyViaAdb({ deviceSerial });
        onSnackbarMessage(
          t("certificatesPage.mobile.adbClearProxySuccessBody", {
            deviceSerial: result.deviceSerial,
          }),
        );
      }

      return true;
    } catch (error) {
      onSnackbarMessage(
        getErrorMessage(
          error,
          action === "set"
            ? t("certificatesPage.mobile.adbSetProxyErrorTitle")
            : t("certificatesPage.mobile.adbClearProxyErrorTitle"),
        ),
      );
      return false;
    } finally {
      setAdbMenuActionPending(false);
    }
  }

  async function handleAdbSetProxy() {
    if (adbMenuActionPending) {
      return;
    }

    setAdbMenuActionPending(true);

    try {
      // Check the proxy before scanning devices so a stopped proxy fails
      // immediately instead of opening the picker only to fail on confirm
      // (`handleAdbProxyForDevice` re-checks for the picker path).
      if (!proxyStatus?.running) {
        throw new Error(t("certificatesPage.mobile.adbProxyRequiresRunningProxy"));
      }

      const adbDevices = await listAndroidAdbDevices();
      const targetDevice = adbDevices[0];

      if (!targetDevice) {
        throw new Error(t("certificatesPage.mobile.adbNoDevices"));
      }

      if (adbDevices.length > 1) {
        onMultipleDevices("set");
        return;
      }

      if (targetDevice.state !== "device") {
        throw new Error(
          t("certificatesPage.mobile.adbDeviceStateHint", {
            state: targetDevice.state,
          }),
        );
      }

      await handleAdbProxyForDevice("set", targetDevice.serial);
    } catch (error) {
      onSnackbarMessage(getErrorMessage(error, t("certificatesPage.mobile.adbSetProxyErrorTitle")));
    } finally {
      setAdbMenuActionPending(false);
    }
  }

  async function handleAdbClearProxy() {
    if (adbMenuActionPending) {
      return;
    }

    setAdbMenuActionPending(true);

    try {
      const adbDevices = await listAndroidAdbDevices();
      const targetDevice = adbDevices[0];

      if (!targetDevice) {
        throw new Error(t("certificatesPage.mobile.adbNoDevices"));
      }

      if (adbDevices.length > 1) {
        onMultipleDevices("clear");
        return;
      }

      if (targetDevice.state !== "device") {
        throw new Error(
          t("certificatesPage.mobile.adbDeviceStateHint", {
            state: targetDevice.state,
          }),
        );
      }

      await handleAdbProxyForDevice("clear", targetDevice.serial);
    } catch (error) {
      onSnackbarMessage(
        getErrorMessage(error, t("certificatesPage.mobile.adbClearProxyErrorTitle")),
      );
    } finally {
      setAdbMenuActionPending(false);
    }
  }

  return {
    adbMenuActionPending,
    handleAdbSetProxy,
    handleAdbClearProxy,
    handleAdbProxyForDevice,
  };
}
