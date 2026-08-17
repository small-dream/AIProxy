import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import { type RefObject, useState } from "react";
import { Alert, AlertTitle, Box, Stack, Typography } from "@mui/material";

import {
  computeMobilePreflight,
  type MobilePreflightGap,
} from "@/features/certificate-center/mobile-preflight.helpers";
import { resolveSelectedLocalIp } from "@/features/certificate-center/local-ip.helpers";
import { useLocalIp } from "@/features/certificate-center/use-mobile-setup";
import { useI18n, type TranslationKey } from "@/i18n";

import { AndroidQuickActionsPanel } from "./AndroidQuickActionsPanel";
import { HarmonyQuickActionsPanel } from "./HarmonyQuickActionsPanel";
import { IosQuickActionsPanel } from "./IosQuickActionsPanel";
import { NetworkInfoPanel } from "./NetworkInfoPanel";
import { QrCodePanel } from "./QrCodePanel";
import { MobileDeviceGuide } from "./MobileDeviceGuide";
import { MobileTrafficCheckCard } from "./MobileTrafficCheckCard";

type Props = {
  proxyPort: number;
  proxyRunning: boolean;
  sslEnabled: boolean;
  hasCert: boolean;
  iosQuickActionsRef?: RefObject<HTMLDivElement | null> | undefined;
  androidQuickActionsRef?: RefObject<HTMLDivElement | null> | undefined;
  harmonyQuickActionsRef?: RefObject<HTMLDivElement | null> | undefined;
};

const GAP_LABEL_KEYS: Record<MobilePreflightGap, TranslationKey> = {
  certGenerated: "mobilePreflight.gaps.certGenerated",
  proxyRunning: "mobilePreflight.gaps.proxyRunning",
  localIp: "mobilePreflight.gaps.localIp",
};

const GAP_HINT_KEYS: Record<MobilePreflightGap, TranslationKey> = {
  certGenerated: "mobilePreflight.gaps.certGeneratedHint",
  proxyRunning: "mobilePreflight.gaps.proxyRunningHint",
  localIp: "mobilePreflight.gaps.localIpHint",
};

function MobilePreflightPanel({ gaps }: { gaps: readonly MobilePreflightGap[] }) {
  const { t } = useI18n();

  return (
    <Alert severity="warning">
      <AlertTitle>{t("mobilePreflight.title")}</AlertTitle>
      <Stack spacing={1} sx={{ mt: 0.5 }}>
        {gaps.map((gap) => (
          <Stack
            key={gap}
            direction="row"
            spacing={1}
            sx={{
              alignItems: "start",
            }}
          >
            <ErrorOutlineRoundedIcon sx={{ fontSize: 18, mt: 0.25, color: "warning.main" }} />
            <Stack spacing={0.25}>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 500,
                }}
              >
                {t(GAP_LABEL_KEYS[gap])}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {t(GAP_HINT_KEYS[gap])}
              </Typography>
            </Stack>
          </Stack>
        ))}
      </Stack>
    </Alert>
  );
}

export function MobileSetupTab({
  proxyPort,
  proxyRunning,
  sslEnabled,
  hasCert,
  iosQuickActionsRef,
  androidQuickActionsRef,
  harmonyQuickActionsRef,
}: Props) {
  const { t } = useI18n();
  const { data: localIps, isLoading: ipsLoading } = useLocalIp();
  // Multi-adapter machines (VPN / virtual bridges) may rank an unreachable
  // address first; the user can switch to one the phone can actually reach.
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const localIp = resolveSelectedLocalIp(localIps, selectedIp);
  const certDownloadUrl =
    localIp && proxyRunning ? `http://${localIp}:${proxyPort}/aiproxy-ca.crt` : null;
  const proxyAddress = localIp ? `${localIp}:${proxyPort}` : null;

  const showCertQr = sslEnabled && hasCert && Boolean(certDownloadUrl);
  const showProxyQr = !sslEnabled && Boolean(proxyAddress);

  const preflight = computeMobilePreflight({
    hasCert,
    proxyRunning,
    localIp: localIp ?? null,
  });

  // Preflight gate: until a cert exists, the proxy is running, and a local IP is
  // reachable, QR codes / ADB / Simulator panels would be useless or misleading.
  // Show a cohesive "complete these first" panel instead; unlock everything once ready.
  if (!preflight.ready) {
    return (
      <Stack spacing={1.5}>
        <MobilePreflightPanel gaps={preflight.gaps} />
      </Stack>
    );
  }

  return (
    <Stack spacing={1.5}>
      {proxyRunning && !sslEnabled && (
        <Alert severity="info">
          <AlertTitle>{t("certificatesPage.mobile.httpOnlyTitle")}</AlertTitle>
          {t("certificatesPage.mobile.httpOnlyBody")}
        </Alert>
      )}

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

          <Box ref={harmonyQuickActionsRef} sx={{ scrollMarginTop: 16 }}>
            <HarmonyQuickActionsPanel
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
            ips={localIps}
            ipsLoading={ipsLoading}
            onSelectIp={setSelectedIp}
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

          <MobileTrafficCheckCard proxyRunning={proxyRunning} />

          <MobileDeviceGuide />
        </Stack>
      </Box>
    </Stack>
  );
}
