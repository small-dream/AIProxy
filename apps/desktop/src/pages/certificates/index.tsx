import { Stack, Typography } from "@mui/material";

import {
  useCertificateStatus,
  useGenerateRootCertificate,
  useOpenCertificateInstallGuide,
  useLaunchCertificateInstaller,
} from "@/features/certificate-center/use-certificate-status";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";

import { CertificateStatusCard } from "./CertificateStatusCard";
import { CertificateActions } from "./CertificateActions";
import { PlatformGuideTabs } from "./PlatformGuideTabs";
import { CertificateRiskNotes } from "./CertificateRiskNotes";
import { MobileSetupCard } from "./MobileSetupCard";

export function CertificatesPage() {
  const { data: status, isLoading, refetch } = useCertificateStatus();
  const generateMutation = useGenerateRootCertificate();
  const guideMutation = useOpenCertificateInstallGuide();
  const installMutation = useLaunchCertificateInstaller();
  const { data: proxyStatus } = useProxyStatus();

  const handleGenerate = () => {
    generateMutation.mutate(undefined, {
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
        <Typography variant="h4">Certificates</Typography>
        <Typography color="text.secondary" variant="body1">
          Prepare HTTPS decryption and platform trust flows before capturing secure traffic.
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
