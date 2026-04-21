import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import { useTheme } from "@mui/material/styles";
import {
  Alert,
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  coerceAppError,
  DEFAULT_PROXY_PORT,
  DEFAULT_WORKSPACE_ID,
  type Workspace,
} from "@aiproxy/shared-types";
import { useEffect, useMemo, useState } from "react";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { SectionCard } from "@/components/shared/SectionCard";
import { useProxyStatus, useStartProxy } from "@/features/proxy-status/use-proxy-status";
import { useUpdateWorkspace, useWorkspaces } from "@/features/workspace-manager/use-workspaces";
import { useI18n } from "@/i18n";
import {
  appFontSizeOptions,
  appFontPreferences,
  contentFontPreferences,
  type AppFontPreference,
  type ContentFontPreference,
} from "@/themes/fonts";

function createProxyDraft(workspace?: Workspace | null) {
  return {
    proxyPort: workspace?.proxyPort ?? DEFAULT_PROXY_PORT,
    sslEnabled: workspace?.sslEnabled ?? true,
  };
}

function ProxySettingsSection() {
  const { t } = useI18n();
  const { data: workspaces = [] } = useWorkspaces();
  const { data: proxyStatus } = useProxyStatus();
  const updateWorkspaceMutation = useUpdateWorkspace();
  const startProxyMutation = useStartProxy();
  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const currentWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === workspaceId) ??
      workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID) ??
      null,
    [workspaceId, workspaces],
  );
  const [draft, setDraft] = useState(createProxyDraft());
  const [feedback, setFeedback] = useState<{ severity: "error" | "success"; message: string } | null>(
    null,
  );

  useEffect(() => {
    setDraft(createProxyDraft(currentWorkspace));
    setFeedback(null);
  }, [currentWorkspace]);

  async function handleSave() {
    if (!currentWorkspace || portError) return;

    setFeedback(null);

    try {
      await updateWorkspaceMutation.mutateAsync({
        proxyPort: draft.proxyPort,
        sslEnabled: draft.sslEnabled,
        workspaceId: currentWorkspace.id,
      });

      if (proxyStatus?.running) {
        await startProxyMutation.mutateAsync({
          enableSsl: draft.sslEnabled,
          port: draft.proxyPort,
          workspaceId: currentWorkspace.id,
        });
      }

      setFeedback({
        message: proxyStatus?.running
          ? t("proxyPresets.saveAndApplySuccess")
          : t("proxyPresets.saveSuccess"),
        severity: "success",
      });
    } catch (error) {
      const normalizedError = coerceAppError(error);
      setFeedback({
        message: normalizedError.message.trim() || t("common.errors.generic"),
        severity: "error",
      });
    }
  }

  const isBusy = updateWorkspaceMutation.isPending || startProxyMutation.isPending;
  const portError = !Number.isInteger(draft.proxyPort) || draft.proxyPort < 1 || draft.proxyPort > 65535;
  const hasChanges = currentWorkspace
    ? currentWorkspace.proxyPort !== draft.proxyPort || currentWorkspace.sslEnabled !== draft.sslEnabled
    : false;

  return (
    <SectionCard title={t("proxyPresets.title")} description={t("proxyPresets.description")}>
      <Stack spacing={2}>
        <Stack direction={{ sm: "row", xs: "column" }} spacing={2} alignItems={{ sm: "center", xs: "stretch" }}>
          <TextField
            size="small"
            type="number"
            label={t("proxyPresets.proxyPort")}
            value={draft.proxyPort}
            onChange={(event) => {
              setDraft({
                ...draft,
                proxyPort: Number(event.target.value) || DEFAULT_PROXY_PORT,
              });
              setFeedback(null);
            }}
            error={portError}
            helperText={portError ? t("proxyPresets.portValidation") : undefined}
            inputProps={{ inputMode: "numeric", min: 1, max: 65535 }}
            sx={{ width: { sm: 220, xs: "100%" } }}
          />

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={draft.sslEnabled}
                onChange={(event) => {
                  setDraft({ ...draft, sslEnabled: event.target.checked });
                  setFeedback(null);
                }}
              />
            }
            label={
              <Typography color="text.secondary" variant="body2">
                {t("proxyPresets.sslEnabled")}
              </Typography>
            }
            sx={{ ml: 0 }}
          />
        </Stack>

        <Alert severity="info" variant="outlined" icon={<CheckCircleRoundedIcon />}>
          {proxyStatus?.running
            ? t("proxyPresets.runningHint")
            : t("proxyPresets.stoppedHint")}
        </Alert>

        <Stack direction="row" justifyContent="flex-end">
          <Button
            size="small"
            variant="contained"
            startIcon={<SaveRoundedIcon />}
            onClick={() => void handleSave()}
            disabled={!currentWorkspace || portError || isBusy || !hasChanges}
          >
            {isBusy ? t("proxyPresets.saving") : t("proxyPresets.save")}
          </Button>
        </Stack>

        {feedback && (
          <Alert severity={feedback.severity} variant="outlined">
            {feedback.message}
          </Alert>
        )}
      </Stack>
    </SectionCard>
  );
}

export function SettingsPage() {
  const { locale, preference, setPreference, t } = useI18n();
  const theme = useTheme();
  const contentCustomFontFamily = useAppPreferencesStore((state) => state.contentCustomFontFamily);
  const contentFontPreference = useAppPreferencesStore((state) => state.contentFontPreference);
  const fontFamilyPreference = useAppPreferencesStore((state) => state.fontFamilyPreference);
  const fontSizePreference = useAppPreferencesStore((state) => state.fontSizePreference);
  const uiCustomFontFamily = useAppPreferencesStore((state) => state.uiCustomFontFamily);
  const setContentCustomFontFamily = useAppPreferencesStore((state) => state.setContentCustomFontFamily);
  const setContentFontPreference = useAppPreferencesStore((state) => state.setContentFontPreference);
  const setFontFamilyPreference = useAppPreferencesStore((state) => state.setFontFamilyPreference);
  const setFontSizePreference = useAppPreferencesStore((state) => state.setFontSizePreference);
  const themePreference = useAppPreferencesStore((state) => state.themePreference);
  const setThemePreference = useAppPreferencesStore((state) => state.setThemePreference);
  const setUiCustomFontFamily = useAppPreferencesStore((state) => state.setUiCustomFontFamily);
  const resolvedLanguageLabel =
    locale === "zh-CN"
      ? t("settingsPage.languageOptionZhCN")
      : t("settingsPage.languageOptionEn");
  const resolvedThemeLabel =
    theme.palette.mode === "dark"
      ? t("settingsPage.themeOptionDark")
      : t("settingsPage.themeOptionLight");
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
  const resolvedUiFontLabel =
    fontFamilyPreference === "custom" && uiCustomFontFamily.trim()
      ? `${t("settingsPage.fontOptionCustom")} (${uiCustomFontFamily.trim()})`
      : fontOptionLabels[fontFamilyPreference];
  const resolvedContentFontLabel =
    contentFontPreference === "custom" && contentCustomFontFamily.trim()
      ? `${t("settingsPage.fontOptionCustom")} (${contentCustomFontFamily.trim()})`
      : contentFontOptionLabels[contentFontPreference];

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">{t("settingsPage.title")}</Typography>
        <Typography color="text.secondary" variant="body1">
          {t("settingsPage.description")}
        </Typography>
      </Stack>

      <ProxySettingsSection />

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

      <SectionCard
        description={t("settingsPage.themeSectionDescription")}
        title={t("settingsPage.themeSectionTitle")}
      >
        <Stack spacing={2.5}>
          <Typography color="text.secondary" variant="body2">
            {t("settingsPage.themeDescription")}
          </Typography>

          <Stack direction={{ sm: "row", xs: "column" }} spacing={2}>
            <FormControl size="small" sx={{ flex: 1, maxWidth: 280 }}>
              <InputLabel>{t("settingsPage.themeLabel")}</InputLabel>
              <Select
                label={t("settingsPage.themeLabel")}
                value={themePreference}
                onChange={(event) => setThemePreference(event.target.value as typeof themePreference)}
              >
                <MenuItem value="system">{t("settingsPage.themeOptionSystem")}</MenuItem>
                <MenuItem value="light">{t("settingsPage.themeOptionLight")}</MenuItem>
                <MenuItem value="dark">{t("settingsPage.themeOptionDark")}</MenuItem>
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ flex: 1, maxWidth: 280 }}>
              <InputLabel>{t("settingsPage.fontLabel")}</InputLabel>
              <Select
                label={t("settingsPage.fontLabel")}
                value={fontFamilyPreference}
                onChange={(event) =>
                  setFontFamilyPreference(event.target.value as AppFontPreference)
                }
              >
                {appFontPreferences.map((option) => (
                  <MenuItem key={option} value={option}>
                    {fontOptionLabels[option]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ flex: 1, maxWidth: 280 }}>
              <InputLabel>{t("settingsPage.contentFontLabel")}</InputLabel>
              <Select
                label={t("settingsPage.contentFontLabel")}
                value={contentFontPreference}
                onChange={(event) =>
                  setContentFontPreference(event.target.value as ContentFontPreference)
                }
              >
                {contentFontPreferences.map((option) => (
                  <MenuItem key={option} value={option}>
                    {contentFontOptionLabels[option]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          <Typography color="text.secondary" variant="body2">
            {t("settingsPage.fontDescription")}
          </Typography>

          {fontFamilyPreference === "custom" ? (
            <TextField
              fullWidth
              label={t("settingsPage.customFontLabel")}
              placeholder={t("settingsPage.customFontPlaceholder")}
              size="small"
              sx={{ maxWidth: 420 }}
              value={uiCustomFontFamily}
              onChange={(event) => setUiCustomFontFamily(event.target.value)}
            />
          ) : null}

          <Stack direction={{ sm: "row", xs: "column" }} spacing={2}>
            <FormControl size="small" sx={{ flex: 1, maxWidth: 280 }}>
              <InputLabel>{t("settingsPage.fontSizeLabel")}</InputLabel>
              <Select
                label={t("settingsPage.fontSizeLabel")}
                value={fontSizePreference}
                onChange={(event) => setFontSizePreference(Number(event.target.value))}
              >
                {appFontSizeOptions.map((size) => (
                  <MenuItem key={size} value={size}>
                    {size}px
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Typography color="text.secondary" variant="body2">
              {t("settingsPage.fontSizeDescription")}
            </Typography>
          </Stack>

          <Typography color="text.secondary" variant="body2">
            {t("settingsPage.contentFontDescription")}
          </Typography>

          {contentFontPreference === "custom" ? (
            <TextField
              fullWidth
              label={t("settingsPage.customContentFontLabel")}
              placeholder={t("settingsPage.customFontPlaceholder")}
              size="small"
              sx={{ maxWidth: 420 }}
              value={contentCustomFontFamily}
              onChange={(event) => setContentCustomFontFamily(event.target.value)}
            />
          ) : null}

          <Alert severity="info" variant="outlined">
            {t("settingsPage.effectiveAppearance", {
              contentFont: resolvedContentFontLabel,
              size: fontSizePreference,
              theme: resolvedThemeLabel,
              uiFont: resolvedUiFontLabel,
            })}
          </Alert>
        </Stack>
      </SectionCard>
    </Stack>
  );
}
