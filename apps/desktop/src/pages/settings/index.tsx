import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import SwapHorizRoundedIcon from "@mui/icons-material/SwapHorizRounded";
import { useTheme } from "@mui/material/styles";
import {
  Alert,
  Button,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { DEFAULT_PROXY_PORT, type Workspace } from "@pharles/shared-types";
import { useEffect, useMemo, useState } from "react";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { SectionCard } from "@/components/shared/SectionCard";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import {
  useCreateWorkspace,
  useLoadWorkspace,
  useUpdateWorkspace,
  useWorkspaces,
} from "@/features/workspace-manager/use-workspaces";
import { useI18n } from "@/i18n";
import { getHoverShadow } from "@/themes/app-theme";

function createEmptyPreset(): Workspace {
  const now = new Date().toISOString();
  return {
    id: "",
    name: "",
    proxyPort: DEFAULT_PROXY_PORT,
    sslEnabled: false,
    systemProxyEnabled: false,
    storagePath: "",
    createdAt: now,
    updatedAt: now,
  };
}

function ProxyPresetsSection() {
  const { t } = useI18n();
  const { data: presets = [] } = useWorkspaces();
  const { data: proxyStatus } = useProxyStatus();
  const createPresetMutation = useCreateWorkspace();
  const updatePresetMutation = useUpdateWorkspace();
  const loadPresetMutation = useLoadWorkspace();

  const activePresetId = proxyStatus?.activeWorkspaceId ?? "default";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Workspace>(createEmptyPreset());
  const [isNew, setIsNew] = useState(false);

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === selectedId) ?? null,
    [presets, selectedId],
  );

  useEffect(() => {
    if (isNew) return;
    if (selectedId && presets.some((p) => p.id === selectedId)) return;

    const active = presets.find((p) => p.id === activePresetId);
    const next = active ?? presets[0];

    if (next) {
      setSelectedId(next.id);
      setDraft(next);
      setIsNew(false);
    }
  }, [activePresetId, isNew, presets, selectedId]);

  function handleSelect(preset: Workspace) {
    setSelectedId(preset.id);
    setDraft(preset);
    setIsNew(false);
  }

  function handleNew() {
    setDraft(createEmptyPreset());
    setSelectedId(null);
    setIsNew(true);
  }

  function handleSave() {
    if (!draft.name.trim()) return;

    if (isNew) {
      createPresetMutation.mutate(
        { name: draft.name.trim(), proxyPort: draft.proxyPort, sslEnabled: draft.sslEnabled },
        { onSuccess: (created) => { setSelectedId(created.id); setDraft(created); setIsNew(false); } },
      );
    } else if (selectedId) {
      updatePresetMutation.mutate(
        { workspaceId: selectedId, name: draft.name.trim(), proxyPort: draft.proxyPort, sslEnabled: draft.sslEnabled },
        { onSuccess: (updated) => { setDraft(updated); } },
      );
    }
  }

  function handleApply() {
    if (!selectedId) return;
    loadPresetMutation.mutate(selectedId);
  }

  const isBusy = createPresetMutation.isPending || updatePresetMutation.isPending || loadPresetMutation.isPending;
  const nameError = draft.name.trim() === "" && draft.name.length > 0;
  const portError = draft.proxyPort !== DEFAULT_PROXY_PORT && (!Number.isInteger(draft.proxyPort) || draft.proxyPort < 1 || draft.proxyPort > 65535);
  const hasErrors = nameError || portError || !draft.name.trim();
  const isActive = selectedId === activePresetId;

  const successMessage = loadPresetMutation.isSuccess
    ? t("proxyPresets.loadSuccess", { name: selectedPreset?.name ?? "" })
    : createPresetMutation.isSuccess
      ? t("proxyPresets.createSuccess")
      : updatePresetMutation.isSuccess
        ? t("proxyPresets.saveSuccess")
        : null;

  return (
    <SectionCard title={t("proxyPresets.title")} description={t("proxyPresets.description")}>
      <Stack spacing={2}>
        <List disablePadding>
          {presets.map((preset, index) => {
            const isActivePreset = preset.id === activePresetId;
            const isSelected = preset.id === selectedId;

            return (
              <Stack key={preset.id}>
                <ListItemButton
                  selected={isSelected}
                  onClick={() => handleSelect(preset)}
                  sx={{
                    borderRadius: 2,
                    px: 1.5,
                    py: 1,
                    transition: "background-color 140ms ease, box-shadow 140ms ease",
                    "&:hover": { boxShadow: (theme) => getHoverShadow(theme.palette.mode) },
                  }}
                >
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography sx={{ fontWeight: isSelected ? 600 : 400, fontSize: 14 }}>
                          {preset.name}
                        </Typography>
                        {isActivePreset && (
                          <CheckCircleRoundedIcon sx={{ fontSize: 14, color: "success.main" }} />
                        )}
                      </Stack>
                    }
                    secondary={`:${preset.proxyPort}`}
                    secondaryTypographyProps={{
                      fontFamily: "JetBrains Mono, Consolas, monospace",
                      fontSize: 12,
                    }}
                  />
                </ListItemButton>
                {index < presets.length - 1 ? <Divider /> : null}
              </Stack>
            );
          })}
        </List>

        <Divider />

        <Stack direction="row" spacing={1} justifyContent="space-between">
          <Button size="small" variant="outlined" onClick={handleNew}>
            {t("proxyPresets.newName")}
          </Button>
          <Stack direction="row" spacing={1}>
            {!isNew && selectedId && !isActive && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<SwapHorizRoundedIcon />}
                onClick={handleApply}
                disabled={isBusy}
              >
                {loadPresetMutation.isPending ? t("proxyPresets.applying") : t("proxyPresets.apply")}
              </Button>
            )}
            <Button
              size="small"
              variant="contained"
              startIcon={<SaveRoundedIcon />}
              onClick={handleSave}
              disabled={hasErrors || isBusy}
            >
              {createPresetMutation.isPending ? t("proxyPresets.creating") : updatePresetMutation.isPending ? t("proxyPresets.saving") : t("proxyPresets.save")}
            </Button>
          </Stack>
        </Stack>

        {(isNew || selectedId) && (
          <Stack spacing={2}>
            <TextField
              size="small"
              fullWidth
              label={t("proxyPresets.newName")}
              placeholder={t("proxyPresets.namePlaceholder")}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              error={nameError}
              helperText={nameError ? t("proxyPresets.nameRequired") : undefined}
            />
            <Stack direction="row" spacing={2} alignItems="center">
              <TextField
                size="small"
                type="number"
                label={t("proxyPresets.proxyPort")}
                value={draft.proxyPort}
                onChange={(event) => setDraft({ ...draft, proxyPort: Number(event.target.value) || DEFAULT_PROXY_PORT })}
                error={portError}
                helperText={portError ? t("proxyPresets.portValidation") : undefined}
                inputProps={{ inputMode: "numeric", min: 1, max: 65535 }}
                sx={{ width: 180 }}
              />
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={draft.sslEnabled}
                    onChange={(event) => setDraft({ ...draft, sslEnabled: event.target.checked })}
                  />
                }
                label={<Typography variant="body2" color="text.secondary">{t("proxyPresets.sslEnabled")}</Typography>}
                sx={{ ml: 0 }}
              />
            </Stack>
          </Stack>
        )}

        {successMessage && (
          <Alert severity="success" variant="outlined">
            {successMessage}
          </Alert>
        )}
      </Stack>
    </SectionCard>
  );
}

export function SettingsPage() {
  const { locale, preference, setPreference, t } = useI18n();
  const theme = useTheme();
  const themePreference = useAppPreferencesStore((state) => state.themePreference);
  const setThemePreference = useAppPreferencesStore((state) => state.setThemePreference);
  const resolvedLanguageLabel =
    locale === "zh-CN"
      ? t("settingsPage.languageOptionZhCN")
      : t("settingsPage.languageOptionEn");
  const resolvedThemeLabel =
    theme.palette.mode === "dark"
      ? t("settingsPage.themeOptionDark")
      : t("settingsPage.themeOptionLight");

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">{t("settingsPage.title")}</Typography>
        <Typography color="text.secondary" variant="body1">
          {t("settingsPage.description")}
        </Typography>
      </Stack>

      <ProxyPresetsSection />

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

          <FormControl size="small" sx={{ maxWidth: 280 }}>
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

          <Alert severity="info" variant="outlined">
            {themePreference === "system"
              ? t("settingsPage.followSystemThemeHint")
              : t("settingsPage.effectiveTheme", { theme: resolvedThemeLabel })}
          </Alert>
        </Stack>
      </SectionCard>
    </Stack>
  );
}
