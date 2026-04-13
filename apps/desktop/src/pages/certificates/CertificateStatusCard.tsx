import { Chip, Stack, Typography } from "@mui/material";
import { type CertificateStatus } from "@pharles/shared-types";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";

type Props = {
  status: CertificateStatus | undefined;
  loading: boolean;
};

export function CertificateStatusCard({ status, loading }: Props) {
  const { t } = useI18n();
  const hasCert = !!status?.certPath;
  const isTrusted = status?.trusted ?? false;

  return (
    <SectionCard title={t("certificatesPage.status.title")} description={t("certificatesPage.status.description")}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="body2" sx={{ minWidth: 120 }}>{t("certificatesPage.status.rootCertificate")}</Typography>
          {loading ? (
            <Chip label={t("common.states.checking")} size="small" />
          ) : hasCert ? (
            <Chip label={t("common.states.present")} color="success" size="small" />
          ) : (
            <Chip label={t("certificatesPage.status.notGenerated")} color="warning" size="small" />
          )}
        </Stack>

        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="body2" sx={{ minWidth: 120 }}>{t("certificatesPage.status.trusted")}</Typography>
          {loading ? (
            <Chip label={t("common.states.checking")} size="small" />
          ) : isTrusted ? (
            <Chip label={t("common.states.trusted")} color="success" size="small" />
          ) : (
            <Chip label={t("common.states.notTrusted")} color="error" size="small" />
          )}
        </Stack>

        {status?.fingerprint ? (
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>{t("certificatesPage.status.fingerprint")}</Typography>
            <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}>
              {status.fingerprint}
            </Typography>
          </Stack>
        ) : null}

        {status?.certPath ? (
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>{t("certificatesPage.status.certificatePath")}</Typography>
            <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}>
              {status.certPath}
            </Typography>
          </Stack>
        ) : null}

        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="body2" sx={{ minWidth: 120 }}>{t("certificatesPage.status.platform")}</Typography>
          <Typography variant="body2">{status?.platform ?? t("common.states.unknown")}</Typography>
        </Stack>
      </Stack>
    </SectionCard>
  );
}
