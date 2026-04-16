import AddRoundedIcon from "@mui/icons-material/AddRounded";
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
import type { ThrottleProfile } from "@aiproxy/shared-types";
import { useEffect, useMemo, useState } from "react";

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
  const saveMutation = useSaveThrottleProfile();
  const setActiveMutation = useSetActiveThrottleProfile();
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [draft, setDraft] = useState<ThrottleProfile>(createEmptyThrottleProfile());

  const activeProfile = useMemo(() => profiles.find((p) => p.enabled), [profiles]);
  const presetProfiles = useMemo(() => profiles.filter((p) => p.preset), [profiles]);
  const customProfiles = useMemo(() => profiles.filter((p) => !p.preset), [profiles]);

  useEffect(() => {
    if (selectedProfileId && profiles.some((p) => p.id === selectedProfileId)) return;
    const next = activeProfile ?? presetProfiles[0] ?? customProfiles[0];
    if (next) { setSelectedProfileId(next.id); setDraft(next); return; }
    setSelectedProfileId(undefined);
  }, [activeProfile, customProfiles, presetProfiles, profiles, selectedProfileId]);

  function selectProfile(profile: ThrottleProfile) { setSelectedProfileId(profile.id); setDraft(profile); }

  function handleNewProfile() {
    const d = createEmptyThrottleProfile();
    setSelectedProfileId(d.id);
    setDraft(d);
  }

  function handleSave(enableAfterSave = false) {
    saveMutation.mutate(
      { ...draft, enabled: enableAfterSave ? true : draft.enabled },
      {
        onSuccess: (saved) => {
          setSelectedProfileId(saved.id);
          setDraft(saved);
          if (enableAfterSave) setActiveMutation.mutate(saved.id);
        },
      },
    );
  }

  const errors = getThrottleValidationErrors(draft, t);

  return (
    <Stack spacing={2.5}>
      {/* Header */}
      <Stack spacing={0.5}>
        <Typography variant="h4">{t("throttlingPage.title")}</Typography>
        <Typography color="text.secondary" variant="body2">
          {t("throttlingPage.description")}
        </Typography>
      </Stack>

      {/* Global control — compact bar */}
      <Paper
        elevation={0}
        sx={{
          border: 1,
          borderColor: "divider",
          borderRadius: 2,
          px: 2,
          py: 1.5,
          boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
        }}
      >
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            {t("throttlingPage.globalTitle")}
          </Typography>
          <Alert
            severity={activeProfile ? "success" : "info"}
            variant="outlined"
            sx={{ flex: 1, py: 0, "& .MuiAlert-message": { py: 0.25 } }}
          >
            {activeProfile
              ? t("throttlingPage.activeSummary", { name: activeProfile.name })
              : t("throttlingPage.inactiveSummary")}
          </Alert>
          <Button size="small" variant="outlined" onClick={() => setActiveMutation.mutate(undefined)}>
            {t("throttlingPage.disableGlobal")}
          </Button>
          <Switch
            size="small"
            checked={Boolean(activeProfile)}
            onChange={(e) => setActiveMutation.mutate(e.target.checked ? draft.id : undefined)}
          />
        </Stack>
      </Paper>

      {/* Main split */}
      <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { lg: "minmax(280px, 320px) minmax(0, 1fr)", xs: "1fr" } }}>
        {/* Left: profile list */}
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              {t("throttlingPage.presetsTitle")}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={handleNewProfile}>
              {t("throttlingPage.newProfile")}
            </Button>
          </Stack>

          <Paper
            elevation={0}
            sx={{ border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden", boxShadow: (theme) => getSurfaceShadow(theme.palette.mode) }}
          >
            <List disablePadding dense>
              {presetProfiles.map((profile, index) => (
                <Box key={profile.id}>
                  <ListItemButton
                    selected={profile.id === selectedProfileId}
                    onClick={() => selectProfile(profile)}
                    sx={{ px: 1.5, py: 1, transition: "background-color 140ms ease", "&:hover": { boxShadow: (theme) => getHoverShadow(theme.palette.mode) } }}
                  >
                    <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        {profile.name.toLowerCase().includes("wifi") ? <WifiTetheringRoundedIcon sx={{ fontSize: 16 }} /> : <SignalCellularAltRoundedIcon sx={{ fontSize: 16 }} />}
                        <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 13 }} noWrap>{profile.name}</Typography>
                        {profile.enabled && <Chip size="small" label={t("throttlingPage.activeChip")} color="success" sx={{ height: 18, fontSize: 10 }} />}
                      </Stack>
                      <Stack direction="row" spacing={0.5}>
                        <Chip size="small" label={t("throttlingPage.latencyChip", { value: profile.latencyMs })} sx={{ height: 18, fontSize: 10 }} />
                        <Chip size="small" label={t("throttlingPage.downloadChip", { value: profile.downloadKbps })} sx={{ height: 18, fontSize: 10 }} />
                        <Chip size="small" label={t("throttlingPage.lossChip", { value: profile.packetLossRatio })} sx={{ height: 18, fontSize: 10 }} />
                      </Stack>
                    </Stack>
                    <Button size="small" variant="outlined" sx={{ flexShrink: 0, minWidth: "auto", px: 1 }} onClick={(e) => { e.stopPropagation(); setActiveMutation.mutate(profile.id); }}>
                      {t("throttlingPage.applyPreset")}
                    </Button>
                  </ListItemButton>
                  {index < presetProfiles.length - 1 && <Divider />}
                </Box>
              ))}

              {customProfiles.length > 0 && presetProfiles.length > 0 && <Divider />}

              {customProfiles.map((profile, index) => (
                <Box key={profile.id}>
                  <ListItemButton
                    selected={profile.id === selectedProfileId}
                    onClick={() => selectProfile(profile)}
                    sx={{ px: 1.5, py: 1, transition: "background-color 140ms ease", "&:hover": { boxShadow: (theme) => getHoverShadow(theme.palette.mode) } }}
                  >
                    <ListItemText
                      primary={(
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 13 }} noWrap>{profile.name || t("throttlingPage.customUntitled")}</Typography>
                          {profile.enabled && <Chip size="small" label={t("throttlingPage.activeChip")} color="success" sx={{ height: 18, fontSize: 10 }} />}
                        </Stack>
                      )}
                      secondary={`${profile.latencyMs} ms • ↓ ${profile.downloadKbps} kbps • ↑ ${profile.uploadKbps} kbps`}
                      secondaryTypographyProps={{ variant: "caption", noWrap: true }}
                    />
                  </ListItemButton>
                  {index < customProfiles.length - 1 && <Divider />}
                </Box>
              ))}
            </List>
          </Paper>
        </Stack>

        {/* Right: editor */}
        <Stack spacing={2}>
          {/* Top bar: name + actions */}
          <Stack direction="row" spacing={1.5} alignItems="center">
            <TextField size="small" label={t("throttlingPage.fields.name")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} sx={{ flex: 1 }} />
            <Switch size="small" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            <Button size="small" variant="outlined" onClick={() => handleSave(false)} disabled={errors.length > 0 || saveMutation.isPending}>
              {t("throttlingPage.saveProfile")}
            </Button>
            <Button size="small" variant="contained" onClick={() => handleSave(true)} disabled={errors.length > 0 || saveMutation.isPending}>
              {t("throttlingPage.saveAndApply")}
            </Button>
          </Stack>

          {/* Validation */}
          {errors.length > 0 && (
            <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>
              <Stack spacing={0.25}>
                {errors.map((err) => <Typography key={err} variant="body2">{err}</Typography>)}
              </Stack>
            </Alert>
          )}

          {/* Parameters */}
          <Paper elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" sx={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 11, mb: 1.5 }}>
              {t("throttlingPage.editorTitle")}
            </Typography>
            <Stack spacing={1.5}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                <TextField size="small" type="number" label={t("throttlingPage.fields.latency")} value={draft.latencyMs} onChange={(e) => setDraft({ ...draft, latencyMs: Number(e.target.value) || 0 })} fullWidth />
                <TextField size="small" type="number" label={t("throttlingPage.fields.loss")} value={draft.packetLossRatio} onChange={(e) => setDraft({ ...draft, packetLossRatio: Number(e.target.value) || 0 })} fullWidth />
              </Stack>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                <TextField size="small" type="number" label={t("throttlingPage.fields.download")} value={draft.downloadKbps} onChange={(e) => setDraft({ ...draft, downloadKbps: Number(e.target.value) || 0 })} fullWidth />
                <TextField size="small" type="number" label={t("throttlingPage.fields.upload")} value={draft.uploadKbps} onChange={(e) => setDraft({ ...draft, uploadKbps: Number(e.target.value) || 0 })} fullWidth />
              </Stack>
            </Stack>
          </Paper>
        </Stack>
      </Box>
    </Stack>
  );
}

function getThrottleValidationErrors(profile: ThrottleProfile, t: ReturnType<typeof useI18n>["t"]): string[] {
  const errors: string[] = [];
  if (!profile.name.trim()) errors.push(t("throttlingPage.validation.nameRequired"));
  if (profile.latencyMs < 0) errors.push(t("throttlingPage.validation.latencyInvalid"));
  if (profile.uploadKbps <= 0 || profile.downloadKbps <= 0) errors.push(t("throttlingPage.validation.bandwidthInvalid"));
  if (profile.packetLossRatio < 0 || profile.packetLossRatio > 100) errors.push(t("throttlingPage.validation.lossInvalid"));
  return errors;
}
