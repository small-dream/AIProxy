import { Stack, Typography } from "@mui/material";

import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";

export function WorkspacesPage() {
  const { t } = useI18n();

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">{t("workspacesPage.title")}</Typography>
        <Typography color="text.secondary" variant="body1">
          {t("workspacesPage.description")}
        </Typography>
      </Stack>

      <SectionCard
        description={t("workspacesPage.managerDescription")}
        title={t("workspacesPage.managerTitle")}
      >
        <Typography color="text.secondary" variant="body2">
          {t("workspacesPage.managerHint")}
        </Typography>
      </SectionCard>
    </Stack>
  );
}
