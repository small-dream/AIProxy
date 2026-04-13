import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import SignalCellularAltRoundedIcon from "@mui/icons-material/SignalCellularAltRounded";
import WifiTetheringRoundedIcon from "@mui/icons-material/WifiTetheringRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type { ThrottleProfile } from "@pharles/shared-types";
import { useEffect, useMemo, useState } from "react";

import { SectionCard } from "@/components/shared/SectionCard";
import {
  useSaveThrottleProfile,
  useSetActiveThrottleProfile,
  useThrottleProfiles,
} from "@/features/throttling/use-throttle-profiles";
import { useI18n } from "@/i18n";
import { getHoverShadow, getSurfaceShadow } from "@/themes/app-theme";

const DEFAULT_WORKSPACE_ID = "default";

function createEmptyThrottleProfile(): ThrottleProfile {
  return {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: "",
    latencyMs: 120,
    uploadKbps: 1000,
    downloadKbps: 4000,
    packetLossRatio: 0,
    enabled: false,
    preset: false,
    note: "",
  };
}

export function ThrottlingPage() {
  const { t } = useI18n();
  const { data: profiles = [] } = useThrottleProfiles();
  const saveThrottleProfileMutation = useSaveThrottleProfile();
  const setActiveThrottleProfileMutation = useSetActiveThrottleProfile();
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [draft, setDraft] = useState<ThrottleProfile>(createEmptyThrottleProfile());

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.enabled),
    [profiles],
  );
  const presetProfiles = useMemo(
    () => profiles.filter((profile) => profile.preset),
    [profiles],
  );
  const customProfiles = useMemo(
    () => profiles.filter((profile) => !profile.preset),
    [profiles],
  );

  useEffect(() => {
    if (selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId)) {
      return;
    }

    const nextProfile = activeProfile ?? presetProfiles[0] ?? customProfiles[0];

    if (nextProfile) {
      setSelectedProfileId(nextProfile.id);
      setDraft(nextProfile);
      return;
    }

    setSelectedProfileId(undefined);
  }, [activeProfile, customProfiles, presetProfiles, profiles, selectedProfileId]);

  function selectProfile(profile: ThrottleProfile) {
    setSelectedProfileId(profile.id);
    setDraft(profile);
  }

  function handleNewProfile() {
    const nextDraft = createEmptyThrottleProfile();
    setSelectedProfileId(nextDraft.id);
    setDraft(nextDraft);
  }

  function handleSave(enableAfterSave = false) {
    saveThrottleProfileMutation.mutate(
      {
        ...draft,
        enabled: enableAfterSave ? true : draft.enabled,
      },
      {
        onSuccess: (savedProfile) => {
          setSelectedProfileId(savedProfile.id);
          setDraft(savedProfile);

          if (enableAfterSave) {
            setActiveThrottleProfileMutation.mutate(savedProfile.id);
          }
        },
      },
    );
  }

  const validationErrors = getThrottleValidationErrors(draft, t);

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">{t("throttlingPage.title")}</Typography>
        <Typography color="text.secondary" variant="body1">
          {t("throttlingPage.description")}
        </Typography>
      </Stack>

      <SectionCard
        title={t("throttlingPage.globalTitle")}
        description={t("throttlingPage.globalDescription")}
        toolbar={(
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2">{t("throttlingPage.globalSwitch")}</Typography>
            <Switch
              checked={Boolean(activeProfile)}
              onChange={(event) => setActiveThrottleProfileMutation.mutate(event.target.checked ? draft.id : undefined)}
            />
          </Stack>
        )}
      >
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <Alert severity={activeProfile ? "success" : "info"} variant="outlined" sx={{ flex: 1 }}>
            {activeProfile
              ? t("throttlingPage.activeSummary", { name: activeProfile.name })
              : t("throttlingPage.inactiveSummary")}
          </Alert>
          <Button variant="outlined" onClick={() => setActiveThrottleProfileMutation.mutate(undefined)}>
            {t("throttlingPage.disableGlobal")}
          </Button>
        </Stack>
      </SectionCard>

      <Box
        sx={{
          display: "grid",
          gap: 3,
          gridTemplateColumns: {
            lg: "minmax(320px, 360px) minmax(0, 1fr)",
            xs: "1fr",
          },
        }}
      >
        <Stack spacing={2}>
          <SectionCard
            title={t("throttlingPage.presetsTitle")}
            description={t("throttlingPage.presetsDescription")}
            toolbar={(
              <Button
                size="small"
                variant="contained"
                startIcon={<BoltRoundedIcon />}
                onClick={handleNewProfile}
              >
                {t("throttlingPage.newProfile")}
              </Button>
            )}
          >
            <Stack spacing={1.25}>
              {presetProfiles.map((profile) => (
                <Paper
                  key={profile.id}
                  elevation={0}
                  sx={{
                    border: 1,
                    borderColor: profile.id === selectedProfileId ? "primary.main" : "divider",
                    borderRadius: 2.5,
                    boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
                    p: 1.5,
                  }}
                >
                  <Stack spacing={1}>
                    <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="center">
                      <Stack direction="row" spacing={1} alignItems="center">
                        {profile.name.toLowerCase().includes("wifi") ? <WifiTetheringRoundedIcon fontSize="small" /> : <SignalCellularAltRoundedIcon fontSize="small" />}
                        <Typography sx={{ fontWeight: 600 }}>{profile.name}</Typography>
                      </Stack>
                      {profile.enabled ? <Chip label={t("throttlingPage.activeChip")} size="small" color="success" /> : null}
                    </Stack>
                    <Typography color="text.secondary" variant="body2">
                      {profile.note}
                    </Typography>
                    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                      <Chip size="small" label={t("throttlingPage.latencyChip", { value: profile.latencyMs })} />
                      <Chip size="small" label={t("throttlingPage.downloadChip", { value: profile.downloadKbps })} />
                      <Chip size="small" label={t("throttlingPage.lossChip", { value: profile.packetLossRatio })} />
                    </Stack>
                    <Stack direction="row" spacing={1}>
                      <Button size="small" variant="outlined" onClick={() => selectProfile(profile)}>
                        {t("throttlingPage.inspectPreset")}
                      </Button>
                      <Button size="small" variant="contained" onClick={() => setActiveThrottleProfileMutation.mutate(profile.id)}>
                        {t("throttlingPage.applyPreset")}
                      </Button>
                    </Stack>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          </SectionCard>

          <Paper
            elevation={0}
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 3,
              boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
              overflow: "hidden",
            }}
          >
            <Box sx={{ p: 2 }}>
              <Typography variant="h6">{t("throttlingPage.customTitle")}</Typography>
              <Typography color="text.secondary" variant="body2" sx={{ mt: 0.5 }}>
                {t("throttlingPage.customDescription")}
              </Typography>
            </Box>
            <Divider />
            {customProfiles.length === 0 ? (
              <Box sx={{ p: 2 }}>
                <Alert severity="info" variant="outlined">
                  {t("throttlingPage.customEmpty")}
                </Alert>
              </Box>
            ) : (
              <List disablePadding>
                {customProfiles.map((profile, index) => (
                  <Box key={profile.id}>
                    <ListItemButton
                      selected={profile.id === selectedProfileId}
                      onClick={() => selectProfile(profile)}
                      sx={{
                        px: 2,
                        py: 1.5,
                        "&:hover": {
                          boxShadow: (theme) => getHoverShadow(theme.palette.mode),
                        },
                      }}
                    >
                      <ListItemText
                        primary={profile.name || t("throttlingPage.customUntitled")}
                        secondary={`${profile.latencyMs} ms • ↓ ${profile.downloadKbps} kbps • ↑ ${profile.uploadKbps} kbps`}
                      />
                      {profile.enabled ? <Chip size="small" label={t("throttlingPage.activeChip")} color="success" /> : null}
                    </ListItemButton>
                    {index < customProfiles.length - 1 ? <Divider /> : null}
                  </Box>
                ))}
              </List>
            )}
          </Paper>
        </Stack>

        <Stack spacing={3}>
          <SectionCard
            title={t("throttlingPage.editorTitle")}
            description={t("throttlingPage.editorDescription")}
          >
            <Stack spacing={2}>
              <TextField
                size="small"
                label={t("throttlingPage.fields.name")}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField
                  size="small"
                  type="number"
                  label={t("throttlingPage.fields.latency")}
                  value={draft.latencyMs}
                  onChange={(event) => setDraft({ ...draft, latencyMs: Number(event.target.value) || 0 })}
                  fullWidth
                />
                <TextField
                  size="small"
                  type="number"
                  label={t("throttlingPage.fields.loss")}
                  value={draft.packetLossRatio}
                  onChange={(event) => setDraft({ ...draft, packetLossRatio: Number(event.target.value) || 0 })}
                  fullWidth
                />
              </Stack>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField
                  size="small"
                  type="number"
                  label={t("throttlingPage.fields.download")}
                  value={draft.downloadKbps}
                  onChange={(event) => setDraft({ ...draft, downloadKbps: Number(event.target.value) || 0 })}
                  fullWidth
                />
                <TextField
                  size="small"
                  type="number"
                  label={t("throttlingPage.fields.upload")}
                  value={draft.uploadKbps}
                  onChange={(event) => setDraft({ ...draft, uploadKbps: Number(event.target.value) || 0 })}
                  fullWidth
                />
              </Stack>
              <TextField
                size="small"
                label={t("throttlingPage.fields.note")}
                multiline
                minRows={2}
                value={draft.note ?? ""}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              />
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2">{t("throttlingPage.fields.enableImmediately")}</Typography>
                <Switch
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
              </Stack>
            </Stack>
          </SectionCard>

          <SectionCard
            title={t("throttlingPage.previewTitle")}
            description={t("throttlingPage.previewDescription")}
          >
            <Stack spacing={1.5}>
              {validationErrors.length > 0 ? (
                <Alert severity="warning" variant="outlined">
                  <Stack spacing={0.5}>
                    {validationErrors.map((error) => (
                      <Typography key={error} variant="body2">
                        {error}
                      </Typography>
                    ))}
                  </Stack>
                </Alert>
              ) : (
                <Alert severity="success" variant="outlined">
                  {t("throttlingPage.previewReady")}
                </Alert>
              )}
              <Stack spacing={0.75}>
                <Typography color="text.secondary" variant="body2">
                  {t("throttlingPage.previewLineOne", {
                    latency: draft.latencyMs,
                    download: draft.downloadKbps,
                    upload: draft.uploadKbps,
                  })}
                </Typography>
                <Typography color="text.secondary" variant="body2">
                  {t("throttlingPage.previewLineTwo", {
                    loss: draft.packetLossRatio,
                    enabled: draft.enabled ? t("throttlingPage.on") : t("throttlingPage.off"),
                  })}
                </Typography>
              </Stack>
            </Stack>
          </SectionCard>

          <Stack direction="row" justifyContent="flex-end" spacing={1}>
            <Button
              variant="outlined"
              onClick={() => handleSave(false)}
              disabled={validationErrors.length > 0 || saveThrottleProfileMutation.isPending}
            >
              {t("throttlingPage.saveProfile")}
            </Button>
            <Button
              variant="contained"
              onClick={() => handleSave(true)}
              disabled={validationErrors.length > 0 || saveThrottleProfileMutation.isPending}
            >
              {t("throttlingPage.saveAndApply")}
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Stack>
  );
}

function getThrottleValidationErrors(
  profile: ThrottleProfile,
  t: ReturnType<typeof useI18n>["t"],
): string[] {
  const errors: string[] = [];

  if (!profile.name.trim()) {
    errors.push(t("throttlingPage.validation.nameRequired"));
  }

  if (profile.latencyMs < 0) {
    errors.push(t("throttlingPage.validation.latencyInvalid"));
  }

  if (profile.uploadKbps <= 0 || profile.downloadKbps <= 0) {
    errors.push(t("throttlingPage.validation.bandwidthInvalid"));
  }

  if (profile.packetLossRatio < 0 || profile.packetLossRatio > 100) {
    errors.push(t("throttlingPage.validation.lossInvalid"));
  }

  return errors;
}
