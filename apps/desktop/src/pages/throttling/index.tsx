import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CloudDownloadRoundedIcon from "@mui/icons-material/CloudDownloadRounded";
import CloudUploadRoundedIcon from "@mui/icons-material/CloudUploadRounded";
import PowerSettingsNewRoundedIcon from "@mui/icons-material/PowerSettingsNewRounded";
import SignalCellularAltRoundedIcon from "@mui/icons-material/SignalCellularAltRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
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
  Slider,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ThrottleProfile } from "@aiproxy/shared-types";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import {
  useSaveThrottleProfile,
  useSetActiveThrottleProfile,
  useThrottleProfiles,
} from "@/features/throttling/use-throttle-profiles";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

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
  const [validationAttempted, setValidationAttempted] = useState(false);

  const activeProfile = useMemo(() => profiles.find((p) => p.enabled), [profiles]);
  const presetProfiles = useMemo(() => profiles.filter((p) => p.preset), [profiles]);
  const customProfiles = useMemo(() => profiles.filter((p) => !p.preset), [profiles]);
  const selectedProfileExists = Boolean(selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId));

  useEffect(() => {
    if (selectedProfileId && profiles.some((p) => p.id === selectedProfileId)) return;
    const next = activeProfile ?? presetProfiles[0] ?? customProfiles[0];
    if (next) { setSelectedProfileId(next.id); setDraft(next); setValidationAttempted(false); return; }
    setSelectedProfileId(undefined);
    setValidationAttempted(false);
  }, [activeProfile, customProfiles, presetProfiles, profiles, selectedProfileId]);

  function selectProfile(profile: ThrottleProfile) {
    setSelectedProfileId(profile.id);
    setDraft(profile);
    setValidationAttempted(false);
  }

  function handleNewProfile() {
    const d = createEmptyThrottleProfile();
    setSelectedProfileId(d.id);
    setDraft(d);
    setValidationAttempted(false);
  }

  function handleSave(enableAfterSave = false) {
    setValidationAttempted(true);
    if (errors.length > 0) return;
    saveMutation.mutate(
      { ...draft, enabled: enableAfterSave ? true : draft.enabled },
      {
        onSuccess: (saved) => {
          setSelectedProfileId(saved.id);
          setDraft(saved);
          setValidationAttempted(false);
          if (enableAfterSave) setActiveMutation.mutate(saved.id);
        },
      },
    );
  }

  function handleGlobalToggle(checked: boolean) {
    if (!checked) {
      setActiveMutation.mutate(undefined);
      return;
    }

    if (selectedProfileExists && selectedProfileId) {
      setActiveMutation.mutate(selectedProfileId);
      return;
    }

    handleSave(true);
  }

  const errors = getThrottleValidationErrors(draft, t);
  const canSave = !saveMutation.isPending;

  return (
    <Stack spacing={0.375} sx={{ height: "100%", minHeight: 0 }}>
      <Paper
        elevation={0}
        sx={(theme) => ({
          bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.94 : 0.98),
          border: "1px solid",
          borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.78 : 0.92),
          borderRadius: 1.25,
          boxShadow:
            theme.palette.mode === "dark"
              ? "0 16px 44px rgba(0, 0, 0, 0.28)"
              : "0 16px 40px rgba(15, 23, 42, 0.08)",
          display: "flex",
          flex: 1,
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        })}
        variant="outlined"
      >
        <Box
          sx={{
            bgcolor: (theme) => theme.palette.mode === "dark"
              ? alpha(theme.palette.background.default, 0.28)
              : alpha(theme.palette.background.default, 0.62),
            borderBottom: 1,
            borderColor: "divider",
            minWidth: 0,
            px: 1.25,
            py: 0.75,
          }}
        >
          <Stack direction={{ xs: "column", md: "row" }} spacing={1} alignItems={{ xs: "stretch", md: "center" }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
                {t("throttlingPage.title")}
              </Typography>
              <Chip
                size="small"
                label={activeProfile ? t("throttlingPage.on") : t("throttlingPage.off")}
                color={activeProfile ? "success" : "default"}
                variant={activeProfile ? "filled" : "outlined"}
                sx={{ fontSize: 11, height: 22 }}
              />
              <Typography color="text.secondary" variant="caption" noWrap sx={{ display: { xs: "none", lg: "block" } }}>
                {activeProfile
                  ? t("throttlingPage.activeSummary", { name: activeProfile.name })
                  : t("throttlingPage.inactiveSummary")}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent={{ xs: "space-between", md: "flex-end" }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<PowerSettingsNewRoundedIcon />}
                onClick={() => setActiveMutation.mutate(undefined)}
                disabled={!activeProfile || setActiveMutation.isPending}
              >
                {t("throttlingPage.disableGlobal")}
              </Button>
              <Switch
                size="small"
                checked={Boolean(activeProfile)}
                onChange={(e) => handleGlobalToggle(e.target.checked)}
                disabled={setActiveMutation.isPending || saveMutation.isPending}
              />
            </Stack>
          </Stack>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
          <Box sx={{ display: "grid", flex: 1, gap: 1, gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, minmax(0, 1fr))" } }}>
            <MetricCard icon={<SpeedRoundedIcon />} label={t("throttlingPage.fields.latency")} value={`${activeProfile?.latencyMs ?? draft.latencyMs} ms`} />
            <MetricCard icon={<CloudDownloadRoundedIcon />} label={t("throttlingPage.fields.download")} value={`${activeProfile?.downloadKbps ?? draft.downloadKbps} kbps`} />
            <MetricCard icon={<CloudUploadRoundedIcon />} label={t("throttlingPage.fields.upload")} value={`${activeProfile?.uploadKbps ?? draft.uploadKbps} kbps`} />
            <MetricCard icon={<SignalCellularAltRoundedIcon />} label={t("throttlingPage.fields.loss")} value={`${activeProfile?.packetLossRatio ?? draft.packetLossRatio}%`} />
          </Box>

      {/* Main split */}
      <Box sx={{ display: "grid", gap: 0, gridTemplateColumns: { lg: "360px 6px minmax(0, 1fr)", xs: "1fr" }, mt: 1.5, minHeight: 560 }}>
        {/* Left: profile list */}
        <Paper
          elevation={0}
          sx={{
            alignSelf: "start",
            bgcolor: (theme) => alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.72 : 0.88),
            border: 1,
            borderColor: "divider",
            borderRadius: "8px",
            overflow: "hidden",
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center" sx={{ borderBottom: 1, borderColor: "divider", p: 1.5 }}>
            <Stack spacing={0.2} sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 650 }}>
                {t("throttlingPage.presetsTitle")}
              </Typography>
              <Typography color="text.secondary" variant="caption" noWrap>
                {t("throttlingPage.presetsDescription")}
              </Typography>
            </Stack>
            <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={handleNewProfile}>
              {t("throttlingPage.newProfile")}
            </Button>
          </Stack>

          <List disablePadding dense sx={{ display: "flex", flexDirection: "column", gap: 0.75, maxHeight: { lg: "calc(100vh - 360px)" }, minHeight: 300, overflow: "auto", p: 1 }}>
            <ProfileListLabel label={t("throttlingPage.presetsTitle")} />
            {presetProfiles.map((profile) => (
              <ProfileListItem
                key={profile.id}
                active={profile.id === selectedProfileId}
                activeChip={t("throttlingPage.activeChip")}
                applyLabel={t("throttlingPage.applyPreset")}
                icon={profile.name.toLowerCase().includes("wifi") ? <WifiTetheringRoundedIcon /> : <SignalCellularAltRoundedIcon />}
                isApplied={profile.enabled}
                name={profile.name}
                onApply={() => setActiveMutation.mutate(profile.id)}
                onSelect={() => selectProfile(profile)}
                summary={formatProfileSummary(profile, t)}
              />
            ))}

            <Divider sx={{ my: 0.25 }} />
            <ProfileListLabel label={t("throttlingPage.customTitle")} />
            {customProfiles.length === 0 ? (
              <Typography color="text.secondary" variant="body2" sx={{ border: 1, borderColor: "divider", borderRadius: "8px", fontSize: 13, px: 1.25, py: 1.5 }}>
                {t("throttlingPage.customEmpty")}
              </Typography>
            ) : customProfiles.map((profile) => (
              <ProfileListItem
                key={profile.id}
                active={profile.id === selectedProfileId}
                activeChip={t("throttlingPage.activeChip")}
                icon={<SignalCellularAltRoundedIcon />}
                isApplied={profile.enabled}
                name={profile.name || t("throttlingPage.customUntitled")}
                onSelect={() => selectProfile(profile)}
                summary={formatProfileSummary(profile, t)}
              />
            ))}
          </List>
        </Paper>

        <Box
          aria-hidden
          sx={{
            alignItems: "center",
            display: { lg: "flex", xs: "none" },
            justifyContent: "center",
            minHeight: 0,
            "&::before": {
              bgcolor: (theme) => alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.46 : 0.62),
              borderRadius: 999,
              content: '""',
              height: "100%",
              width: 1,
            },
          }}
        />

        {/* Right: editor */}
        <Paper
          elevation={0}
          sx={{
            bgcolor: (theme) => alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.76 : 0.92),
            border: 1,
            borderColor: "divider",
            borderRadius: "8px",
            minWidth: 0,
            p: 2,
          }}
        >
          <Stack spacing={2}>
          {/* Top bar: name + actions */}
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1.25}
            alignItems={{ xs: "stretch", md: "center" }}
            sx={{ borderBottom: 1, borderColor: "divider", pb: 1.5 }}
          >
            <TextField size="small" label={t("throttlingPage.fields.name")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} sx={{ flex: 1 }} />
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ border: 1, borderColor: "divider", borderRadius: "8px", minHeight: 40, px: 1 }}>
              <Typography color="text.secondary" variant="caption">{t("throttlingPage.fields.enableImmediately")}</Typography>
              <Switch size="small" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            </Stack>
            <Button size="small" variant="outlined" onClick={() => handleSave(false)} disabled={!canSave}>
              {t("throttlingPage.saveProfile")}
            </Button>
            <Button size="small" variant="contained" onClick={() => handleSave(true)} disabled={!canSave || setActiveMutation.isPending}>
              {t("throttlingPage.saveAndApply")}
            </Button>
          </Stack>

          {/* Validation */}
          {validationAttempted && errors.length > 0 && (
            <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>
              <Stack spacing={0.25}>
                {errors.map((err) => <Typography key={err} variant="body2">{err}</Typography>)}
              </Stack>
            </Alert>
          )}

          {/* Parameters */}
          <Paper elevation={0} sx={{ bgcolor: "background.paper", border: 1, borderColor: "divider", borderRadius: "8px", p: 2 }}>
            <Stack spacing={0.35} sx={{ mb: 1.5 }}>
              <Typography variant="subtitle2" color="text.secondary" sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 0, textTransform: "uppercase" }}>
                {t("throttlingPage.editorTitle")}
              </Typography>
              <Typography color="text.secondary" variant="caption">
                {t("throttlingPage.editorDescription")}
              </Typography>
            </Stack>

            <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" } }}>
              <ThrottleParameter
                icon={<SpeedRoundedIcon />}
                label={t("throttlingPage.fields.latency")}
                max={2000}
                min={0}
                step={10}
                unit="ms"
                value={draft.latencyMs}
                onChange={(value) => setDraft({ ...draft, latencyMs: value })}
              />
              <ThrottleParameter
                icon={<SignalCellularAltRoundedIcon />}
                label={t("throttlingPage.fields.loss")}
                max={100}
                min={0}
                step={1}
                unit="%"
                value={draft.packetLossRatio}
                onChange={(value) => setDraft({ ...draft, packetLossRatio: value })}
              />
              <ThrottleParameter
                icon={<CloudDownloadRoundedIcon />}
                label={t("throttlingPage.fields.download")}
                max={100000}
                min={1}
                step={100}
                unit="kbps"
                value={draft.downloadKbps}
                onChange={(value) => setDraft({ ...draft, downloadKbps: value })}
              />
              <ThrottleParameter
                icon={<CloudUploadRoundedIcon />}
                label={t("throttlingPage.fields.upload")}
                max={50000}
                min={1}
                step={100}
                unit="kbps"
                value={draft.uploadKbps}
                onChange={(value) => setDraft({ ...draft, uploadKbps: value })}
              />
            </Box>
          </Paper>

          <Alert severity="info" variant="outlined" sx={{ py: 0 }}>
            <Stack spacing={0.25}>
              <Typography variant="body2">
                {t("throttlingPage.previewTitle")}
              </Typography>
              <Typography color="text.secondary" variant="caption">
                {t("throttlingPage.previewLineOne", {
                  download: draft.downloadKbps,
                  latency: draft.latencyMs,
                  upload: draft.uploadKbps,
                })}
              </Typography>
              <Typography color="text.secondary" variant="caption">
                {t("throttlingPage.previewLineTwo", {
                  enabled: draft.enabled ? t("throttlingPage.on") : t("throttlingPage.off"),
                  loss: draft.packetLossRatio,
                })}
              </Typography>
            </Stack>
          </Alert>
          </Stack>
        </Paper>
      </Box>
        </Box>
      </Paper>
    </Stack>
  );
}

function MetricCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        minWidth: 0,
        px: 1.25,
        py: 0.9,
      }}
    >
      <Box sx={{ color: "primary.main", display: "flex", "& svg": { fontSize: 18 } }}>
        {icon}
      </Box>
      <Stack sx={{ minWidth: 0 }}>
        <Typography color="text.secondary" variant="caption" noWrap>
          {label}
        </Typography>
        <Typography sx={{ fontFamily: fontFamilies.mono, fontSize: 13, fontWeight: 650 }} noWrap>
          {value}
        </Typography>
      </Stack>
    </Stack>
  );
}

function ProfileListLabel({ label }: { label: string }) {
  return (
    <Typography color="text.secondary" variant="caption" sx={{ fontSize: 11, fontWeight: 700, px: 0.5, textTransform: "uppercase" }}>
      {label}
    </Typography>
  );
}

function ProfileListItem(props: {
  active: boolean;
  activeChip: string;
  applyLabel?: string;
  icon: ReactNode;
  isApplied: boolean;
  name: string;
  onApply?: () => void;
  onSelect: () => void;
  summary: string;
}) {
  const { active, activeChip, applyLabel, icon, isApplied, name, onApply, onSelect, summary } = props;

  return (
    <ListItemButton
      selected={active}
      onClick={onSelect}
      sx={{
        border: 1,
        borderColor: active ? "primary.main" : "divider",
        borderRadius: "8px",
        gap: 1,
        px: 1.25,
        py: 1,
        transition: "border-color 140ms ease, background-color 140ms ease",
        "&.Mui-selected": {
          bgcolor: (theme) => alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.08),
        },
        "&:hover": {
          bgcolor: (theme) => alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.13 : 0.055),
          borderColor: (theme) => alpha(theme.palette.primary.main, 0.45),
        },
      }}
    >
      <Box sx={{ color: active ? "primary.main" : "text.secondary", display: "flex", flexShrink: 0, "& svg": { fontSize: 18 } }}>
        {icon}
      </Box>
      <ListItemText
        primary={(
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="body2" sx={{ fontWeight: 650, fontSize: 13 }} noWrap>
              {name}
            </Typography>
            {isApplied && <Chip size="small" label={activeChip} color="success" sx={{ fontSize: 10, height: 18 }} />}
          </Stack>
        )}
        secondary={summary}
        secondaryTypographyProps={{ noWrap: true, sx: { fontSize: 11.5 } }}
        sx={{ minWidth: 0 }}
      />
      {onApply && (
        <Button
          size="small"
          variant={isApplied ? "contained" : "outlined"}
          sx={{ flexShrink: 0, minWidth: "auto", px: 1 }}
          onClick={(event) => {
            event.stopPropagation();
            onApply();
          }}
        >
          {applyLabel}
        </Button>
      )}
    </ListItemButton>
  );
}

function ThrottleParameter(props: {
  icon: ReactNode;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  unit: string;
  value: number;
}) {
  const { icon, label, max, min, onChange, step, unit, value } = props;
  const sliderValue = Math.min(max, Math.max(min, value));

  return (
    <Stack
      spacing={1}
      sx={{
        bgcolor: (theme) => alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.035 : 0.025),
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        p: 1.5,
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        <Box sx={{ color: "primary.main", display: "flex", "& svg": { fontSize: 18 } }}>
          {icon}
        </Box>
        <Typography variant="body2" sx={{ flex: 1, fontWeight: 650 }}>
          {label}
        </Typography>
        <Typography color="text.secondary" sx={{ fontFamily: fontFamilies.mono, fontSize: 12 }}>
          {value} {unit}
        </Typography>
      </Stack>
      <Slider
        size="small"
        min={min}
        max={max}
        step={step}
        value={sliderValue}
        onChange={(_, nextValue) => onChange(Array.isArray(nextValue) ? nextValue[0] : nextValue)}
      />
      <TextField
        size="small"
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
        inputProps={{ min, step }}
        fullWidth
      />
    </Stack>
  );
}

function formatProfileSummary(profile: ThrottleProfile, t: ReturnType<typeof useI18n>["t"]) {
  return t("throttlingPage.customSummary", {
    download: profile.downloadKbps,
    latency: profile.latencyMs,
    upload: profile.uploadKbps,
  });
}

function getThrottleValidationErrors(profile: ThrottleProfile, t: ReturnType<typeof useI18n>["t"]): string[] {
  const errors: string[] = [];
  if (!profile.name.trim()) errors.push(t("throttlingPage.validation.nameRequired"));
  if (profile.latencyMs < 0) errors.push(t("throttlingPage.validation.latencyInvalid"));
  if (profile.uploadKbps <= 0 || profile.downloadKbps <= 0) errors.push(t("throttlingPage.validation.bandwidthInvalid"));
  if (profile.packetLossRatio < 0 || profile.packetLossRatio > 100) errors.push(t("throttlingPage.validation.lossInvalid"));
  return errors;
}
