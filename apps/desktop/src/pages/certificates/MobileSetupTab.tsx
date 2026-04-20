import type { RefObject } from "react";
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
  const { data: localIps, isLoading: ipsLoading } = useLocalIp();
  const localIp = localIps?.[0];
  const certDownloadUrl = localIp && proxyRunning ? `http://${localIp}:${proxyPort}/aiproxy-ca.crt` : null;
  const proxyAddress = localIp ? `${localIp}:${proxyPort}` : null;

  const showCertQr = sslEnabled && hasCert && Boolean(certDownloadUrl);
  const showProxyQr = !sslEnabled && Boolean(proxyAddress);

  return (
    <Stack spacing={2}>
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

      <Box ref={iosQuickActionsRef} sx={{ scrollMarginTop: 16 }}>
        <IosQuickActionsPanel hasCert={hasCert} />
      </Box>

      <Box ref={androidQuickActionsRef} sx={{ scrollMarginTop: 16 }}>
        <AndroidQuickActionsPanel
          hasCert={hasCert}
          localIp={localIp ?? null}
          proxyPort={proxyPort}
          proxyRunning={proxyRunning}
        />
      </Box>

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
  );
}
