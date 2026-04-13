import { Alert, AlertTitle, Stack } from "@mui/material";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";

export function CertificateRiskNotes() {
  const { t } = useI18n();

  return (
    <SectionCard title={t("certificatesPage.risks.sectionTitle")} description={t("certificatesPage.risks.sectionDescription")}>
      <Stack spacing={2}>
        <Alert severity="warning">
          <AlertTitle>{t("certificatesPage.risks.mitmTitle")}</AlertTitle>
          {t("certificatesPage.risks.mitmBody")}
        </Alert>

        <Alert severity="info">
          <AlertTitle>{t("certificatesPage.risks.undoTitle")}</AlertTitle>
          {t("certificatesPage.risks.undoBody")}
        </Alert>

        <Alert severity="info">
          <AlertTitle>{t("certificatesPage.risks.pinningTitle")}</AlertTitle>
          {t("certificatesPage.risks.pinningBody")}
        </Alert>
      </Stack>
    </SectionCard>
  );
}
