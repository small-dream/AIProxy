import { useEffect, useState, type RefObject } from "react";
import { Alert, AlertTitle, Box, Stack } from "@mui/material";
import { useLocalIp } from "@/features/certificate-center/use-mobile-setup";
import { useI18n } from "@/i18n";

import { AndroidQuickActionsPanel } from "./AndroidQuickActionsPanel";
import { IosQuickActionsPanel } from "./IosQuickActionsPanel";
import { NetworkInfoPanel } from "./NetworkInfoPanel";
import { QrCodePanel } from "./QrCodePanel";
import { MobileDeviceGuide } from "./MobileDeviceGuide";

type Props = {
  proxyPort: number;
  proxyRunning: boolean;
  sslEnabled: boolean;
  hasCert: boolean;
  iosQuickActionsRef?: RefObject<HTMLDivElement | null> | undefined;
  androidQuickActionsRef?: RefObject<HTMLDivElement | null> | undefined;
};

export function MobileSetupTab({
  proxyPort,
  proxyRunning,
  sslEnabled,
  hasCert,
  iosQuickActionsRef,
  androidQuickActionsRef,
}: Props) {
  const { t } = useI18n();
  const [devicesQueryEnabled, setDevicesQueryEnabled] = useState(false);
  const { data: localIps, isLoading: ipsLoading } = useLocalIp();
  const localIp = localIps?.[0];
  const certDownloadUrl =
    localIp && proxyRunning ? `http://${localIp}:${proxyPort}/aiproxy-ca.crt` : null;
  const proxyAddress = localIp ? `${localIp}:${proxyPort}` : null;

  const showCertQr = sslEnabled && hasCert && Boolean(certDownloadUrl);
  const showProxyQr = !sslEnabled && Boolean(proxyAddress);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDevicesQueryEnabled(true);
    }, 150);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  return (
    <Stack spacing={1.5}>
      <Stack spacing={1}>
        {!proxyRunning && (
          <Alert severity="warning">
            <AlertTitle>{t("certificatesPage.mobile.proxyNotRunningTitle")}</AlertTitle>
            {t("certificatesPage.mobile.proxyNotRunningBody")}
          </Alert>
        )}

        {proxyRunning && !sslEnabled && (
          <Alert severity="info">
            <AlertTitle>{t("certificatesPage.mobile.httpOnlyTitle")}</AlertTitle>
            {t("certificatesPage.mobile.httpOnlyBody")}
          </Alert>
        )}
      </Stack>

      <Box
        sx={{
          alignItems: "start",
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: {
            xs: "minmax(0, 1fr)",
            md: "minmax(0, 1.08fr) minmax(340px, 0.92fr)",
          },
        }}
      >
        <Stack spacing={1.5} sx={{ minWidth: 0 }}>
          <Box ref={iosQuickActionsRef} sx={{ scrollMarginTop: 16 }}>
            <IosQuickActionsPanel devicesQueryEnabled={devicesQueryEnabled} hasCert={hasCert} />
          </Box>

          <Box ref={androidQuickActionsRef} sx={{ scrollMarginTop: 16 }}>
            <AndroidQuickActionsPanel
              devicesQueryEnabled={devicesQueryEnabled}
              hasCert={hasCert}
              localIp={localIp ?? null}
              proxyPort={proxyPort}
              proxyRunning={proxyRunning}
            />
          </Box>
        </Stack>

        <Stack spacing={1.5} sx={{ minWidth: 0 }}>
          <NetworkInfoPanel
            localIp={localIp ?? null}
            ipsLoading={ipsLoading}
            proxyPort={proxyPort}
            proxyAddress={proxyAddress}
          />

          {(showCertQr || showProxyQr) && (
            <QrCodePanel
              certDownloadUrl={certDownloadUrl}
              proxyAddress={proxyAddress}
              sslEnabled={sslEnabled}
              hasCert={hasCert}
            />
          )}

          <MobileDeviceGuide />
        </Stack>
      </Box>
    </Stack>
  );
}
