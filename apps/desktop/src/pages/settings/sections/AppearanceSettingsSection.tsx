import { MenuItem, Select, TextField } from "@mui/material";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";
import {
  appFontSizeOptions,
  appFontPreferences,
  contentFontPreferences,
  type AppFontPreference,
  type ContentFontPreference,
} from "@/themes/fonts";
import { selectControlSx, SettingsGroup, SettingsRow } from "../SettingsLayoutParts";

export function AppearanceSettingsSection() {
  const { preference, setPreference, t } = useI18n();
  const contentCustomFontFamily = useAppPreferencesStore((state) => state.contentCustomFontFamily);
  const contentFontPreference = useAppPreferencesStore((state) => state.contentFontPreference);
  const fontFamilyPreference = useAppPreferencesStore((state) => state.fontFamilyPreference);
  const fontSizePreference = useAppPreferencesStore((state) => state.fontSizePreference);
  const uiCustomFontFamily = useAppPreferencesStore((state) => state.uiCustomFontFamily);
  const setContentCustomFontFamily = useAppPreferencesStore(
    (state) => state.setContentCustomFontFamily,
  );
  const setContentFontPreference = useAppPreferencesStore(
    (state) => state.setContentFontPreference,
  );
  const setFontFamilyPreference = useAppPreferencesStore((state) => state.setFontFamilyPreference);
  const setFontSizePreference = useAppPreferencesStore((state) => state.setFontSizePreference);
  const themePreference = useAppPreferencesStore((state) => state.themePreference);
  const setThemePreference = useAppPreferencesStore((state) => state.setThemePreference);
  const setUiCustomFontFamily = useAppPreferencesStore((state) => state.setUiCustomFontFamily);

  const fontOptionLabels: Record<AppFontPreference, string> = {
    system: t("settingsPage.fontOptionSystem"),
    pingfang: t("settingsPage.fontOptionPingFang"),
    "noto-sans-sc": t("settingsPage.fontOptionNotoSansSc"),
    "source-han-sans": t("settingsPage.fontOptionSourceHanSans"),
    serif: t("settingsPage.fontOptionSerif"),
    custom: t("settingsPage.fontOptionCustom"),
  };
  const contentFontOptionLabels: Record<ContentFontPreference, string> = {
    "follow-ui": t("settingsPage.contentFontOptionFollowUi"),
    "system-mono": t("settingsPage.contentFontOptionSystemMono"),
    system: t("settingsPage.fontOptionSystem"),
    pingfang: t("settingsPage.fontOptionPingFang"),
    "noto-sans-sc": t("settingsPage.fontOptionNotoSansSc"),
    "source-han-sans": t("settingsPage.fontOptionSourceHanSans"),
    serif: t("settingsPage.fontOptionSerif"),
    custom: t("settingsPage.fontOptionCustom"),
  };

  return (
    <SectionCard compact title={t("settingsPage.generalSectionTitle")}>
      <SettingsGroup>
        <SettingsRow itemId="language" label={t("settingsPage.languageLabel")}>
          <Select
            size="small"
            value={preference}
            onChange={(event) => setPreference(event.target.value as typeof preference)}
            inputProps={{ "aria-label": t("settingsPage.languageLabel") }}
            sx={selectControlSx}
          >
            <MenuItem value="system">{t("settingsPage.languageOptionSystem")}</MenuItem>
            <MenuItem value="zh-CN">{t("settingsPage.languageOptionZhCN")}</MenuItem>
            <MenuItem value="en">{t("settingsPage.languageOptionEn")}</MenuItem>
          </Select>
        </SettingsRow>

        <SettingsRow itemId="theme" label={t("settingsPage.themeLabel")}>
          <Select
            size="small"
            value={themePreference}
            onChange={(event) => setThemePreference(event.target.value as typeof themePreference)}
            inputProps={{ "aria-label": t("settingsPage.themeLabel") }}
            sx={selectControlSx}
          >
            <MenuItem value="system">{t("settingsPage.themeOptionSystem")}</MenuItem>
            <MenuItem value="light">{t("settingsPage.themeOptionLight")}</MenuItem>
            <MenuItem value="dark">{t("settingsPage.themeOptionDark")}</MenuItem>
          </Select>
        </SettingsRow>

        <SettingsRow itemId="ui-font" label={t("settingsPage.fontLabel")}>
          <Select
            size="small"
            value={fontFamilyPreference}
            onChange={(event) => setFontFamilyPreference(event.target.value as AppFontPreference)}
            inputProps={{ "aria-label": t("settingsPage.fontLabel") }}
            sx={selectControlSx}
          >
            {appFontPreferences.map((option) => (
              <MenuItem key={option} value={option}>
                {fontOptionLabels[option]}
              </MenuItem>
            ))}
          </Select>
        </SettingsRow>

        {fontFamilyPreference === "custom" ? (
          <SettingsRow label={t("settingsPage.customFontLabel")}>
            <TextField
              size="small"
              hiddenLabel
              placeholder={t("settingsPage.customFontPlaceholder")}
              value={uiCustomFontFamily}
              onChange={(event) => setUiCustomFontFamily(event.target.value)}
              slotProps={{ htmlInput: { "aria-label": t("settingsPage.customFontLabel") } }}
              sx={selectControlSx}
            />
          </SettingsRow>
        ) : null}

        <SettingsRow itemId="content-font" label={t("settingsPage.contentFontLabel")}>
          <Select
            size="small"
            value={contentFontPreference}
            onChange={(event) =>
              setContentFontPreference(event.target.value as ContentFontPreference)
            }
            inputProps={{ "aria-label": t("settingsPage.contentFontLabel") }}
            sx={selectControlSx}
          >
            {contentFontPreferences.map((option) => (
              <MenuItem key={option} value={option}>
                {contentFontOptionLabels[option]}
              </MenuItem>
            ))}
          </Select>
        </SettingsRow>

        {contentFontPreference === "custom" ? (
          <SettingsRow label={t("settingsPage.customContentFontLabel")}>
            <TextField
              size="small"
              hiddenLabel
              placeholder={t("settingsPage.customFontPlaceholder")}
              value={contentCustomFontFamily}
              onChange={(event) => setContentCustomFontFamily(event.target.value)}
              slotProps={{
                htmlInput: { "aria-label": t("settingsPage.customContentFontLabel") },
              }}
              sx={selectControlSx}
            />
          </SettingsRow>
        ) : null}

        <SettingsRow itemId="font-size" label={t("settingsPage.fontSizeLabel")}>
          <Select
            size="small"
            value={fontSizePreference}
            onChange={(event) => setFontSizePreference(Number(event.target.value))}
            inputProps={{ "aria-label": t("settingsPage.fontSizeLabel") }}
            sx={{ ...selectControlSx, width: { sm: 140, xs: "100%" } }}
          >
            {appFontSizeOptions.map((size) => (
              <MenuItem key={size} value={size}>
                {size}px
              </MenuItem>
            ))}
          </Select>
        </SettingsRow>
      </SettingsGroup>
    </SectionCard>
  );
}
