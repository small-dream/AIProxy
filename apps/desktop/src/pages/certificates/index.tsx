import { Stack, Typography } from "@mui/material";

import {
  useCertificateStatus,
  useGenerateRootCertificate,
  useLaunchCertificateInstaller,
} from "@/features/certificate-center/use-certificate-status";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useI18n } from "@/i18n";

import { CertificateStatusCard } from "./CertificateStatusCard";
import { CertificateActions } from "./CertificateActions";
import { PlatformGuideTabs } from "./PlatformGuideTabs";
import { CertificateRiskNotes } from "./CertificateRiskNotes";
import { MobileSetupCard } from "./MobileSetupCard";

export function CertificatesPage() {
  const { t } = useI18n();
  const { data: status, isLoading, refetch } = useCertificateStatus();
  const generateMutation = useGenerateRootCertificate();
  const installMutation = useLaunchCertificateInstaller();
  const { data: proxyStatus } = useProxyStatus();

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
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">{t("certificatesPage.title")}</Typography>
        <Typography color="text.secondary" variant="body1">
          {t("certificatesPage.description")}
        </Typography>
      </Stack>

      <CertificateStatusCard status={status} loading={isLoading} />

      <CertificateActions
        status={status}
        generating={generateMutation.isPending}
        installing={installMutation.isPending}
        loading={isLoading}
        onGenerate={handleGenerate}
        onInstall={handleInstall}
        onRefresh={handleRefresh}
      />

      <PlatformGuideTabs currentPlatform={status?.platform ?? "windows"} />

      <MobileSetupCard
        proxyPort={proxyStatus?.port ?? 8888}
        proxyRunning={proxyStatus?.running ?? false}
        sslEnabled={proxyStatus?.sslEnabled ?? false}
        hasCert={!!status?.certPath}
      />

      <CertificateRiskNotes />
    </Stack>
  );
}
