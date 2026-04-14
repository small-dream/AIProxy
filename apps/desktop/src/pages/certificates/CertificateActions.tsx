import { Button, CircularProgress, Stack } from "@mui/material";
import { type CertificateStatus } from "@pharles/shared-types";
import { useI18n } from "@/i18n";

type Props = {
  status: CertificateStatus | undefined;
  generating: boolean;
  installing: boolean;
  onGenerate: () => void;
  onInstall: () => void;
  onRefresh: () => void;
  loading: boolean;
};

export function CertificateActions({ status, generating, installing, onGenerate, onInstall, onRefresh, loading }: Props) {
  const { t } = useI18n();
  const hasCert = !!status?.certPath;
  const isTrusted = status?.trusted ?? false;
  const supportsInstaller = status?.platform === "windows" || status?.platform === "macos";
  const showInstallButton = supportsInstaller && hasCert && !isTrusted;

  return (
    <Stack direction="row" spacing={2}>
      <Button
        variant="contained"
        onClick={onGenerate}
        disabled={loading || generating || installing || (hasCert && isTrusted)}
        startIcon={generating ? <CircularProgress size={16} /> : undefined}
      >
        {generating ? t("certificatesPage.actions.generating") : hasCert ? t("certificatesPage.actions.regenerate") : t("certificatesPage.actions.generate")}
      </Button>

      {showInstallButton && (
        <Button
          variant="contained"
          color="success"
          onClick={onInstall}
          disabled={loading || installing || generating}
          startIcon={installing ? <CircularProgress size={16} /> : undefined}
        >
          {installing ? t("certificatesPage.actions.opening") : t("certificatesPage.actions.install")}
        </Button>
      )}

      <Button
        variant="outlined"
        onClick={onRefresh}
        disabled={loading}
        startIcon={loading ? <CircularProgress size={16} /> : undefined}
      >
        {t("common.actions.refreshStatus")}
      </Button>
    </Stack>
  );
}
