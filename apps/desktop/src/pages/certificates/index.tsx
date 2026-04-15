import { useState } from "react";
import { Stack, Tab, Tabs, Typography } from "@mui/material";

import {
  useCertificateStatus,
  useGenerateRootCertificate,
  useLaunchCertificateInstaller,
} from "@/features/certificate-center/use-certificate-status";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useI18n } from "@/i18n";

import { DesktopCertificateTab } from "./DesktopCertificateTab";
import { PlatformTrustGuide } from "./PlatformTrustGuide";
import { MobileSetupTab } from "./MobileSetupTab";
import { ReferenceTab } from "./ReferenceTab";

type CertTab = "desktop" | "mobile" | "reference";

export function CertificatesPage() {
  const { t } = useI18n();
  const { data: status, isLoading, refetch } = useCertificateStatus();
  const generateMutation = useGenerateRootCertificate();
  const installMutation = useLaunchCertificateInstaller();
  const { data: proxyStatus } = useProxyStatus();
  const [tab, setTab] = useState<CertTab>("desktop");

  const handleGenerate = () => {
    generateMutation.mutate({ forceRegenerate: Boolean(status?.certPath) }, {
      onSuccess: () => {
        refetch();
      },
    });
  };

  const handleInstall = () => {
    installMutation.mutate();
  };

  const handleRefresh = () => {
    refetch();
  };

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t("certificatesPage.title")}</Typography>
        <Typography color="text.secondary" variant="body2">
          {t("certificatesPage.description")}
        </Typography>
      </Stack>

      {/* Top-level Tabs */}
      <Tabs
        value={tab}
        onChange={(_, v: CertTab) => setTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: "divider" }}
      >
        <Tab label={t("certificatesPage.tabs.desktop")} value="desktop" />
        <Tab label={t("certificatesPage.tabs.mobile")} value="mobile" />
        <Tab label={t("certificatesPage.tabs.reference")} value="reference" />
      </Tabs>

      {/* Tab panels */}
      {tab === "desktop" && (
        <Stack spacing={2}>
          <DesktopCertificateTab
            status={status}
            loading={isLoading}
            generating={generateMutation.isPending}
            installing={installMutation.isPending}
            onGenerate={handleGenerate}
            onInstall={handleInstall}
            onRefresh={handleRefresh}
          />
          <PlatformTrustGuide currentPlatform={status?.platform ?? "windows"} />
        </Stack>
      )}

      {tab === "mobile" && (
        <MobileSetupTab
          proxyPort={proxyStatus?.port ?? 8888}
          proxyRunning={proxyStatus?.running ?? false}
          sslEnabled={proxyStatus?.sslEnabled ?? false}
          hasCert={!!status?.certPath}
        />
      )}

      {tab === "reference" && (
        <ReferenceTab currentPlatform={status?.platform ?? "windows"} />
      )}
    </Stack>
  );
}
