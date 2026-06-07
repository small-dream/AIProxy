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

interface UseAdbActionsParams {
  port: number;
  proxyStatus: ProxyStatusLike | undefined;
  onSnackbarMessage: (message: string | null) => void;
}

/**
 * Manages ADB device proxy set/clear actions with loading state.
 */
export function useAdbActions({ port, proxyStatus, onSnackbarMessage }: UseAdbActionsParams) {
  const { t } = useI18n();
  const [adbMenuActionPending, setAdbMenuActionPending] = useState(false);

  async function handleAdbSetProxy() {
    if (adbMenuActionPending) {
      return;
    }

    setAdbMenuActionPending(true);

    try {
      if (!proxyStatus?.running) {
        throw new Error(t("certificatesPage.mobile.adbProxyRequiresRunningProxy"));
      }

      const adbDevices = await listAndroidAdbDevices();
      const targetDevice = adbDevices[0];

      if (!targetDevice) {
        throw new Error(t("certificatesPage.mobile.adbNoDevices"));
      }

      if (targetDevice.state !== "device") {
        throw new Error(
          t("certificatesPage.mobile.adbDeviceStateHint", {
            state: targetDevice.state,
          }),
        );
      }

      const localIps = await getLocalIp();
      const localIp = localIps[0];

      if (!localIp) {
        throw new Error(t("certificatesPage.mobile.adbProxyRequiresLocalIp"));
      }

      const result = await setAndroidProxyViaAdb({
        deviceSerial: targetDevice.serial,
        host: localIp,
        port,
      });

      onSnackbarMessage(
        t("certificatesPage.mobile.adbSetProxySuccessBody", {
          deviceSerial: result.deviceSerial,
          proxyAddress: result.proxyAddress ?? `${localIp}:${port}`,
        }),
      );
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

      if (targetDevice.state !== "device") {
        throw new Error(
          t("certificatesPage.mobile.adbDeviceStateHint", {
            state: targetDevice.state,
          }),
        );
      }

      const result = await clearAndroidProxyViaAdb({
        deviceSerial: targetDevice.serial,
      });
      onSnackbarMessage(
        t("certificatesPage.mobile.adbClearProxySuccessBody", {
          deviceSerial: result.deviceSerial,
        }),
      );
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
  };
}
