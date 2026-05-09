import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Button,
  Box,
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

const compactAlertSx = {
  alignItems: "center",
  borderRadius: 1.5,
  px: 1.5,
  py: 0.75,
  "& .MuiAlert-icon": {
    fontSize: 20,
    mr: 1.25,
    py: 0,
  },
  "& .MuiAlert-message": {
    fontSize: 13,
    lineHeight: 1.45,
    py: 0,
  },
};

const compactFieldSx = {
  "& .MuiInputBase-root": {
    minHeight: 38,
  },
  "& .MuiInputLabel-root": {
    fontSize: 13,
  },
};

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
    <SectionCard compact title={t("proxyPresets.title")} description={t("proxyPresets.description")}>
      <Stack spacing={1.5}>
        <Stack
          direction={{ md: "row", xs: "column" }}
          spacing={1.5}
          alignItems={{ md: "center", xs: "stretch" }}
          justifyContent="space-between"
        >
          <Stack
            direction={{ sm: "row", xs: "column" }}
            spacing={1.5}
            alignItems={{ sm: "center", xs: "stretch" }}
          >
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
              sx={{ ...compactFieldSx, width: { sm: 180, xs: "100%" } }}
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

          <Button
            size="small"
            variant="contained"
            startIcon={<SaveRoundedIcon />}
            onClick={() => void handleSave()}
            disabled={!currentWorkspace || portError || isBusy || !hasChanges}
            sx={{ minHeight: 34, px: 1.75 }}
          >
            {isBusy ? t("proxyPresets.saving") : t("proxyPresets.save")}
          </Button>
        </Stack>

        <Alert severity="info" variant="outlined" icon={<CheckCircleRoundedIcon />} sx={compactAlertSx}>
          {proxyStatus?.running
            ? t("proxyPresets.runningHint")
            : t("proxyPresets.stoppedHint")}
        </Alert>

        {feedback && (
          <Alert severity={feedback.severity} variant="outlined" sx={compactAlertSx}>
            {feedback.message}
          </Alert>
        )}
      </Stack>
    </SectionCard>
  );
}

export function SettingsPage() {
  const { preference, setPreference, t } = useI18n();
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
    <Stack spacing={2} sx={{ maxWidth: 1180, mx: "auto", width: "100%" }}>
      <Stack spacing={0.25}>
        <Typography variant="h4" sx={{ fontSize: 30, lineHeight: 1.15 }}>
          {t("settingsPage.title")}
        </Typography>
        <Typography color="text.secondary" variant="body2">
          {t("settingsPage.description")}
        </Typography>
      </Stack>

      <ProxySettingsSection />

      <SectionCard compact title={t("settingsPage.languageSectionTitle")}>
        <FormControl size="small" sx={{ ...compactFieldSx, width: { sm: 260, xs: "100%" } }}>
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
      </SectionCard>

      <SectionCard compact title={t("settingsPage.themeSectionTitle")}>
        <Stack spacing={1.5}>
          <Box
            sx={{
              display: "grid",
              gap: 1.5,
              gridTemplateColumns: {
                md: "repeat(4, minmax(160px, 1fr))",
                sm: "repeat(2, minmax(180px, 1fr))",
                xs: "1fr",
              },
              maxWidth: 980,
            }}
          >
            <FormControl size="small" sx={compactFieldSx}>
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

            <FormControl size="small" sx={compactFieldSx}>
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

            <FormControl size="small" sx={compactFieldSx}>
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

            <FormControl size="small" sx={compactFieldSx}>
              <InputLabel>{t("settingsPage.fontSizeLabel")}</InputLabel>
              <Select
                size="small"
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
          </Box>

          {fontFamilyPreference === "custom" ? (
            <TextField
              fullWidth
              label={t("settingsPage.customFontLabel")}
              placeholder={t("settingsPage.customFontPlaceholder")}
              size="small"
              sx={{ ...compactFieldSx, maxWidth: 420 }}
              value={uiCustomFontFamily}
              onChange={(event) => setUiCustomFontFamily(event.target.value)}
            />
          ) : null}

          {contentFontPreference === "custom" ? (
            <TextField
              fullWidth
              label={t("settingsPage.customContentFontLabel")}
              placeholder={t("settingsPage.customFontPlaceholder")}
              size="small"
              sx={{ ...compactFieldSx, maxWidth: 420 }}
              value={contentCustomFontFamily}
              onChange={(event) => setContentCustomFontFamily(event.target.value)}
            />
          ) : null}
        </Stack>
      </SectionCard>
    </Stack>
  );
}
