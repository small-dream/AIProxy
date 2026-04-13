import { Alert, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from "@mui/material";

import { useI18n } from "@/i18n";
import { SectionCard } from "@/components/shared/SectionCard";

export function SettingsPage() {
  const { locale, preference, setPreference, t } = useI18n();
  const resolvedLanguageLabel =
    locale === "zh-CN"
      ? t("settingsPage.languageOptionZhCN")
      : t("settingsPage.languageOptionEn");

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">{t("settingsPage.title")}</Typography>
        <Typography color="text.secondary" variant="body1">
          {t("settingsPage.description")}
        </Typography>
      </Stack>

      <SectionCard
        description={t("settingsPage.languageSectionDescription")}
        title={t("settingsPage.languageSectionTitle")}
      >
        <Stack spacing={2.5}>
          <Typography color="text.secondary" variant="body2">
            {t("settingsPage.languageDescription")}
          </Typography>

          <FormControl size="small" sx={{ maxWidth: 280 }}>
            <InputLabel>{t("settingsPage.languageLabel")}</InputLabel>
            <Select
              label={t("settingsPage.languageLabel")}
              value={preference}
              onChange={(event) => setPreference(event.target.value as typeof preference)}
            >
              <MenuItem value="system">{t("settingsPage.languageOptionSystem")}</MenuItem>
              <MenuItem value="zh-CN">{t("settingsPage.languageOptionZhCN")}</MenuItem>
              <MenuItem value="en">{t("settingsPage.languageOptionEn")}</MenuItem>
            </Select>
          </FormControl>

          <Alert severity="info" variant="outlined">
            {preference === "system"
              ? t("settingsPage.followSystemHint")
              : t("settingsPage.effectiveLanguage", { language: resolvedLanguageLabel })}
          </Alert>
        </Stack>
      </SectionCard>
    </Stack>
  );
}
