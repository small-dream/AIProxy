import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CloudDownloadRoundedIcon from "@mui/icons-material/CloudDownloadRounded";
import CloudUploadRoundedIcon from "@mui/icons-material/CloudUploadRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import FilterAltRoundedIcon from "@mui/icons-material/FilterAltRounded";
import PowerSettingsNewRoundedIcon from "@mui/icons-material/PowerSettingsNewRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import SignalCellularAltRoundedIcon from "@mui/icons-material/SignalCellularAltRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
import TimerOutlinedIcon from "@mui/icons-material/TimerOutlined";
import WifiTetheringRoundedIcon from "@mui/icons-material/WifiTetheringRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Slider,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ThrottleProfile, ThrottleRule } from "@aiproxy/shared-types";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

import {
  useDeleteThrottleRule,
  useSaveThrottleProfile,
  useSaveThrottleRule,
  useSetActiveThrottleProfile,
  useThrottleProfiles,
  useThrottleRules,
  useThrottleRuntimeStats,
} from "@/features/throttling/use-throttle-profiles";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

const DEFAULT_WORKSPACE_ID = "default";
const TEMP_ENABLE_MS = 15 * 60 * 1000;

type ThrottleSeed = {
  host?: string;
  method?: string;
  path?: string;
  url?: string;
};

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

function createRuleDraft(profileId: string, seed?: ThrottleSeed): ThrottleRule {
  const urlPattern = seed?.url
    ? seed.url
    : seed?.host
      ? `*://${seed.host}${seed.path && seed.path !== "/" ? seed.path : "/*"}`
      : "*";

  return {
    id: crypto.randomUUID(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: seed?.host ? `${seed.method ?? "Any"} ${seed.host}` : "Targeted rule",
    enabled: true,
    priority: 100,
    profileId,
    urlPattern,
    methods: seed?.method ? [seed.method] : [],
    stage: "both",
    note: "",
  };
}

export function ThrottlingPage() {
  const { t } = useI18n();
  const location = useLocation();
  const seed = (location.state as { throttleSeed?: ThrottleSeed } | null)?.throttleSeed;
  const { data: profiles = [] } = useThrottleProfiles();
  const { data: rules = [] } = useThrottleRules();
  const { data: stats } = useThrottleRuntimeStats();
  const saveProfileMutation = useSaveThrottleProfile();
  const saveRuleMutation = useSaveThrottleRule();
  const deleteRuleMutation = useDeleteThrottleRule();
  const setActiveMutation = useSetActiveThrottleProfile();
  const [mode, setMode] = useState<"profiles" | "rules">("profiles");
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [selectedRuleId, setSelectedRuleId] = useState<string>();
  const [profileDraft, setProfileDraft] = useState<ThrottleProfile>(createEmptyThrottleProfile());
  const [ruleDraft, setRuleDraft] = useState<ThrottleRule | null>(null);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [temporaryUntil, setTemporaryUntil] = useState<number | null>(null);
  const activeProfile = useMemo(() => profiles.find((profile) => profile.enabled), [profiles]);
  const presetProfiles = useMemo(() => profiles.filter((profile) => profile.preset), [profiles]);
  const customProfiles = useMemo(() => profiles.filter((profile) => !profile.preset), [profiles]);
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId],
  );
  const selectedRule = useMemo(
    () => rules.find((rule) => rule.id === selectedRuleId),
    [rules, selectedRuleId],
  );
  const activeRuleCount = useMemo(() => rules.filter((rule) => rule.enabled).length, [rules]);

  useEffect(() => {
    if (seed && profiles.length > 0) {
      const baseProfile = activeProfile ?? profiles[0];
      if (!baseProfile) return;
      const draft = createRuleDraft(baseProfile.id, seed);
      setMode("rules");
      setSelectedRuleId(draft.id);
      setRuleDraft(draft);
    }
  }, [activeProfile, profiles, seed]);

  useEffect(() => {
    if (selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId)) return;
    const next = activeProfile ?? presetProfiles[0] ?? customProfiles[0];
    if (!next) return;
    setSelectedProfileId(next.id);
    setProfileDraft(next);
  }, [activeProfile, customProfiles, presetProfiles, profiles, selectedProfileId]);

  useEffect(() => {
    if (!selectedProfile) return;
    if (mode === "profiles") {
      setProfileDraft(selectedProfile);
      setValidationAttempted(false);
    }
  }, [mode, selectedProfile]);

  useEffect(() => {
    if (selectedRule) {
      setRuleDraft(selectedRule);
      return;
    }

    if (!ruleDraft && rules[0]) {
      setSelectedRuleId(rules[0].id);
      setRuleDraft(rules[0]);
    }
  }, [ruleDraft, rules, selectedRule]);

  useEffect(() => {
    if (!temporaryUntil) return undefined;
    const timeout = window.setTimeout(() => {
      setActiveMutation.mutate(undefined);
      setTemporaryUntil(null);
    }, Math.max(0, temporaryUntil - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [setActiveMutation, temporaryUntil]);

  const profileErrors = getThrottleValidationErrors(profileDraft, t);
  const ruleErrors = ruleDraft ? getRuleValidationErrors(ruleDraft) : [];
  const activeStatusLabel = activeProfile
    ? t("throttlingPage.activeSummary", { name: activeProfile.name })
    : t("throttlingPage.inactiveSummary");
  const temporaryRemaining = temporaryUntil ? Math.max(0, temporaryUntil - Date.now()) : 0;

  function selectProfile(profile: ThrottleProfile) {
    setMode("profiles");
    setSelectedProfileId(profile.id);
    setProfileDraft(profile);
    setValidationAttempted(false);
  }

  function handleNewProfile() {
    const draft = createEmptyThrottleProfile();
    setMode("profiles");
    setSelectedProfileId(draft.id);
    setProfileDraft(draft);
    setValidationAttempted(false);
  }

  function handleSaveProfile(enableAfterSave = false) {
    setValidationAttempted(true);
    if (profileErrors.length > 0) return;
    saveProfileMutation.mutate(
      { ...profileDraft, enabled: enableAfterSave ? true : profileDraft.enabled },
      {
        onSuccess: (saved) => {
          setSelectedProfileId(saved.id);
          setProfileDraft(saved);
          setValidationAttempted(false);
          if (enableAfterSave) setActiveMutation.mutate(saved.id);
        },
      },
    );
  }

  function handleTemporaryEnable() {
    const target = selectedProfileId ?? activeProfile?.id ?? profiles[0]?.id;
    if (!target) return;
    setTemporaryUntil(Date.now() + TEMP_ENABLE_MS);
    setActiveMutation.mutate(target);
  }

  function handleNewRule() {
    const profileId = activeProfile?.id ?? selectedProfileId ?? profiles[0]?.id;
    if (!profileId) return;
    const draft = createRuleDraft(profileId);
    setMode("rules");
    setSelectedRuleId(draft.id);
    setRuleDraft(draft);
    setValidationAttempted(false);
  }

  function handleSaveRule() {
    if (!ruleDraft) return;
    setValidationAttempted(true);
    if (ruleErrors.length > 0) return;
    saveRuleMutation.mutate(ruleDraft, {
      onSuccess: (saved) => {
        setSelectedRuleId(saved.id);
        setRuleDraft(saved);
        setValidationAttempted(false);
      },
    });
  }

  function updateRuleDraft(patch: Partial<ThrottleRule>) {
    setRuleDraft((current) => current ? { ...current, ...patch } : current);
  }

  return (
    <Stack spacing={1} sx={{ height: "100%", minHeight: 0 }}>
      <Paper elevation={0} variant="outlined" sx={{ borderRadius: "8px", overflow: "hidden" }}>
        <Box sx={{ px: 1.5, py: 1.25 }}>
          <Stack direction={{ xs: "column", lg: "row" }} spacing={1.25} alignItems={{ xs: "stretch", lg: "center" }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ color: activeProfile ? "success.main" : "text.secondary", display: "flex" }}>
                <WifiTetheringRoundedIcon fontSize="small" />
              </Box>
              <Stack sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={0.75} alignItems="center">
                  <Typography variant="subtitle2" sx={{ fontWeight: 750 }} noWrap>{t("throttlingPage.title")}</Typography>
                  <Chip
                    size="small"
                    color={activeProfile ? "success" : "default"}
                    label={activeProfile ? t("throttlingPage.on") : t("throttlingPage.off")}
                    sx={{ height: 20, fontSize: 11 }}
                  />
                  {temporaryUntil ? <Chip size="small" icon={<TimerOutlinedIcon />} label={`${Math.ceil(temporaryRemaining / 60000)} min`} sx={{ height: 20, fontSize: 11 }} /> : null}
                </Stack>
                <Typography color="text.secondary" variant="caption" noWrap>
                  {activeStatusLabel} Scope: global profile + {activeRuleCount} targeted {activeRuleCount === 1 ? "rule" : "rules"}.
                </Typography>
              </Stack>
            </Stack>

            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              <StatusPill icon={<RuleRoundedIcon />} label="Hits" value={String(stats?.matchedRequests ?? 0)} />
              <StatusPill icon={<SignalCellularAltRoundedIcon />} label="Drops" value={String(stats?.droppedRequests ?? 0)} />
              <StatusPill icon={<SpeedRoundedIcon />} label="Delay" value={`${formatDelay((stats?.requestDelayMs ?? 0) + (stats?.responseDelayMs ?? 0))}`} />
              <Button size="small" variant="outlined" startIcon={<TimerOutlinedIcon />} onClick={handleTemporaryEnable} disabled={profiles.length === 0 || setActiveMutation.isPending}>
                15 min
              </Button>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                startIcon={<PowerSettingsNewRoundedIcon />}
                onClick={() => { setTemporaryUntil(null); setActiveMutation.mutate(undefined); }}
                disabled={!activeProfile || setActiveMutation.isPending}
              >
                {t("throttlingPage.disableGlobal")}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Paper>

      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", xl: "380px minmax(0, 1fr)" }, minHeight: 0, flex: 1 }}>
        <Paper elevation={0} variant="outlined" sx={{ borderRadius: "8px", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ borderBottom: 1, borderColor: "divider", px: 1.25, py: 1 }}>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={mode}
              onChange={(_, value) => value && setMode(value)}
              sx={{ flex: 1, "& .MuiToggleButton-root": { flex: 1, py: 0.45 } }}
            >
              <ToggleButton value="profiles">Profiles</ToggleButton>
              <ToggleButton value="rules">Rules</ToggleButton>
            </ToggleButtonGroup>
          </Stack>

          <Box sx={{ minHeight: 0, overflow: "auto", p: 1 }}>
            {mode === "profiles" ? (
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="caption" color="text.secondary" sx={{ flex: 1, fontWeight: 700, textTransform: "uppercase" }}>{t("throttlingPage.presetsTitle")}</Typography>
                  <Button size="small" startIcon={<AddRoundedIcon />} onClick={handleNewProfile}>{t("throttlingPage.newProfile")}</Button>
                </Stack>
                <ProfileList profiles={presetProfiles} activeProfileId={activeProfile?.id} selectedProfileId={selectedProfileId} onApply={(id) => setActiveMutation.mutate(id)} onSelect={selectProfile} />
                <Divider />
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: "uppercase" }}>{t("throttlingPage.customTitle")}</Typography>
                {customProfiles.length === 0 ? (
                  <EmptyHint>{t("throttlingPage.customEmpty")}</EmptyHint>
                ) : (
                  <ProfileList profiles={customProfiles} activeProfileId={activeProfile?.id} selectedProfileId={selectedProfileId} onApply={(id) => setActiveMutation.mutate(id)} onSelect={selectProfile} />
                )}
              </Stack>
            ) : (
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="caption" color="text.secondary" sx={{ flex: 1, fontWeight: 700, textTransform: "uppercase" }}>Targeted rules</Typography>
                  <Button size="small" startIcon={<AddRoundedIcon />} onClick={handleNewRule} disabled={profiles.length === 0}>New rule</Button>
                </Stack>
                {rules.length === 0 ? (
                  <EmptyHint>Create a host, URL, or method scoped rule when global throttling is too broad.</EmptyHint>
                ) : (
                  <List dense disablePadding sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
                    {[...rules].sort((a, b) => b.priority - a.priority).map((rule) => (
                      <ListItemButton
                        key={rule.id}
                        selected={rule.id === selectedRuleId}
                        onClick={() => { setSelectedRuleId(rule.id); setRuleDraft(rule); }}
                        sx={{ border: 1, borderColor: rule.id === selectedRuleId ? "primary.main" : "divider", borderRadius: "8px", px: 1.25 }}
                      >
                        <RuleRoundedIcon sx={{ color: rule.enabled ? "primary.main" : "text.secondary", fontSize: 18, mr: 1 }} />
                        <ListItemText
                          primary={<Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>{rule.name}</Typography>}
                          secondary={`${rule.urlPattern} • ${rule.methods.length ? rule.methods.join(", ") : "Any method"} • ${rule.stage}`}
                          secondaryTypographyProps={{ noWrap: true, sx: { fontSize: 11.5 } }}
                        />
                        <Chip size="small" label={rule.priority} sx={{ height: 20, fontSize: 11 }} />
                      </ListItemButton>
                    ))}
                  </List>
                )}
              </Stack>
            )}
          </Box>
        </Paper>

        <Paper elevation={0} variant="outlined" sx={{ borderRadius: "8px", minHeight: 0, overflow: "auto", p: 1.5 }}>
          {mode === "profiles" ? (
            <ProfileEditor
              active={activeProfile?.id === profileDraft.id}
              canSave={!saveProfileMutation.isPending}
              draft={profileDraft}
              errors={validationAttempted ? profileErrors : []}
              onChange={setProfileDraft}
              onSave={() => handleSaveProfile(false)}
              onSaveAndApply={() => handleSaveProfile(true)}
              t={t}
            />
          ) : (
            <RuleEditor
              draft={ruleDraft}
              errors={validationAttempted ? ruleErrors : []}
              profiles={profiles}
              onChange={updateRuleDraft}
              onDelete={(ruleId) => {
                deleteRuleMutation.mutate(ruleId, {
                  onSuccess: () => {
                    setSelectedRuleId(undefined);
                    setRuleDraft(null);
                  },
                });
              }}
              onSave={handleSaveRule}
              saving={saveRuleMutation.isPending}
            />
          )}
        </Paper>
      </Box>
    </Stack>
  );
}

function StatusPill({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <Stack direction="row" spacing={0.65} alignItems="center" sx={{ bgcolor: "action.hover", border: 1, borderColor: "divider", borderRadius: "8px", minHeight: 30, px: 1 }}>
      <Box sx={{ color: "text.secondary", display: "flex", "& svg": { fontSize: 16 } }}>{icon}</Box>
      <Typography color="text.secondary" variant="caption">{label}</Typography>
      <Typography sx={{ fontFamily: fontFamilies.mono, fontSize: 12.5, fontWeight: 700 }}>{value}</Typography>
    </Stack>
  );
}

function ProfileList(props: {
  activeProfileId: string | undefined;
  onApply: (id: string) => void;
  onSelect: (profile: ThrottleProfile) => void;
  profiles: ThrottleProfile[];
  selectedProfileId: string | undefined;
}) {
  const { activeProfileId, onApply, onSelect, profiles, selectedProfileId } = props;

  return (
    <List dense disablePadding sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      {profiles.map((profile) => (
        <ListItemButton
          key={profile.id}
          selected={selectedProfileId === profile.id}
          onClick={() => onSelect(profile)}
          sx={(theme) => ({
            border: 1,
            borderColor: selectedProfileId === profile.id ? "primary.main" : "divider",
            borderRadius: "8px",
            px: 1.25,
            py: 0.9,
            "&.Mui-selected": {
              bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.07),
            },
          })}
        >
          <Box sx={{ color: profile.enabled ? "success.main" : "text.secondary", display: "flex", mr: 1 }}>
            {profile.name.toLowerCase().includes("wifi") ? <WifiTetheringRoundedIcon sx={{ fontSize: 18 }} /> : <SignalCellularAltRoundedIcon sx={{ fontSize: 18 }} />}
          </Box>
          <ListItemText
            primary={(
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>{profile.name}</Typography>
                {activeProfileId === profile.id ? <Chip size="small" color="success" label="Active" sx={{ height: 18, fontSize: 10 }} /> : null}
              </Stack>
            )}
            secondary={`${profile.latencyMs} ms • ↓ ${profile.downloadKbps} kbps • ↑ ${profile.uploadKbps} kbps • loss ${profile.packetLossRatio}%`}
            secondaryTypographyProps={{ noWrap: true, sx: { fontSize: 11.5 } }}
          />
          <Button size="small" variant={activeProfileId === profile.id ? "contained" : "outlined"} onClick={(event) => { event.stopPropagation(); onApply(profile.id); }} sx={{ minWidth: 58 }}>
            Apply
          </Button>
        </ListItemButton>
      ))}
    </List>
  );
}

function ProfileEditor(props: {
  active: boolean;
  canSave: boolean;
  draft: ThrottleProfile;
  errors: string[];
  onChange: (draft: ThrottleProfile) => void;
  onSave: () => void;
  onSaveAndApply: () => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const { active, canSave, draft, errors, onChange, onSave, onSaveAndApply, t } = props;

  return (
    <Stack spacing={1.5}>
      <EditorHeader
        icon={<SignalCellularAltRoundedIcon />}
        title={draft.name || t("throttlingPage.customUntitled")}
        subtitle={active ? "This profile is currently applied globally." : "Tune the profile, then apply it globally or use it from targeted rules."}
      />
      <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
        <TextField size="small" label={t("throttlingPage.fields.name")} value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} sx={{ flex: 1 }} />
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ border: 1, borderColor: "divider", borderRadius: "8px", px: 1.25 }}>
          <Typography color="text.secondary" variant="caption">{t("throttlingPage.fields.enableImmediately")}</Typography>
          <Switch size="small" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} />
        </Stack>
      </Stack>
      {errors.length > 0 ? <Alert severity="warning" variant="outlined">{errors.join(" ")}</Alert> : null}
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" } }}>
        <ThrottleParameter icon={<SpeedRoundedIcon />} label={t("throttlingPage.fields.latency")} max={2000} min={0} step={10} unit="ms" value={draft.latencyMs} onChange={(value) => onChange({ ...draft, latencyMs: value })} />
        <ThrottleParameter icon={<SignalCellularAltRoundedIcon />} label={t("throttlingPage.fields.loss")} max={100} min={0} step={1} unit="%" value={draft.packetLossRatio} onChange={(value) => onChange({ ...draft, packetLossRatio: value })} />
        <ThrottleParameter icon={<CloudDownloadRoundedIcon />} label={t("throttlingPage.fields.download")} max={100000} min={1} step={100} unit="kbps" value={draft.downloadKbps} onChange={(value) => onChange({ ...draft, downloadKbps: value })} />
        <ThrottleParameter icon={<CloudUploadRoundedIcon />} label={t("throttlingPage.fields.upload")} max={50000} min={1} step={100} unit="kbps" value={draft.uploadKbps} onChange={(value) => onChange({ ...draft, uploadKbps: value })} />
      </Box>
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button variant="outlined" onClick={onSave} disabled={!canSave}>{t("throttlingPage.saveProfile")}</Button>
        <Button variant="contained" onClick={onSaveAndApply} disabled={!canSave}>{t("throttlingPage.saveAndApply")}</Button>
      </Stack>
    </Stack>
  );
}

function RuleEditor(props: {
  draft: ThrottleRule | null;
  errors: string[];
  profiles: ThrottleProfile[];
  onChange: (patch: Partial<ThrottleRule>) => void;
  onDelete: (ruleId: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { draft, errors, profiles, onChange, onDelete, onSave, saving } = props;

  if (!draft) {
    return <EmptyHint>Select a rule, or create one from a captured Session to scope weak-network simulation precisely.</EmptyHint>;
  }

  return (
    <Stack spacing={1.5}>
      <EditorHeader
        icon={<FilterAltRoundedIcon />}
        title={draft.name}
        subtitle="Rules run before the global profile. Highest priority matching rule wins."
      />
      {errors.length > 0 ? <Alert severity="warning" variant="outlined">{errors.join(" ")}</Alert> : null}
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", md: "1.2fr 0.8fr" } }}>
        <TextField size="small" label="Rule name" value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />
        <FormControl size="small">
          <InputLabel>Profile</InputLabel>
          <Select label="Profile" value={draft.profileId} onChange={(event) => onChange({ profileId: event.target.value })}>
            {profiles.map((profile) => (
              <MenuItem key={profile.id} value={profile.id}>{profile.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField size="small" label="URL / Host pattern" value={draft.urlPattern} onChange={(event) => onChange({ urlPattern: event.target.value })} />
        <TextField
          size="small"
          label="Methods"
          placeholder="GET, POST, PUT"
          value={draft.methods.join(", ")}
          onChange={(event) => onChange({ methods: event.target.value.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean) })}
        />
        <FormControl size="small">
          <InputLabel>Stage</InputLabel>
          <Select label="Stage" value={draft.stage} onChange={(event) => onChange({ stage: event.target.value as ThrottleRule["stage"] })}>
            <MenuItem value="both">Request + response</MenuItem>
            <MenuItem value="request">Request only</MenuItem>
            <MenuItem value="response">Response only</MenuItem>
          </Select>
        </FormControl>
        <TextField size="small" label="Priority" type="number" value={draft.priority} onChange={(event) => onChange({ priority: Number(event.target.value) || 0 })} />
      </Box>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ border: 1, borderColor: "divider", borderRadius: "8px", px: 1.25, py: 0.75 }}>
        <Switch size="small" checked={draft.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
        <Typography variant="body2" sx={{ fontWeight: 650 }}>Enabled</Typography>
        <Typography color="text.secondary" variant="caption">Only matching traffic uses this profile.</Typography>
      </Stack>
      <Stack direction="row" spacing={1} justifyContent="space-between">
        <Button color="error" variant="outlined" startIcon={<DeleteOutlineRoundedIcon />} onClick={() => onDelete(draft.id)}>Delete</Button>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<ReplayRoundedIcon />} onClick={() => onChange({ id: crypto.randomUUID(), name: `${draft.name} copy` })}>Duplicate</Button>
          <Button variant="contained" onClick={onSave} disabled={saving}>Save Rule</Button>
        </Stack>
      </Stack>
    </Stack>
  );
}

function EditorHeader({ icon, title, subtitle }: { icon: ReactNode; subtitle: string; title: string }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ borderBottom: 1, borderColor: "divider", pb: 1 }}>
      <Box sx={{ alignItems: "center", bgcolor: "action.selected", borderRadius: "8px", color: "primary.main", display: "flex", height: 34, justifyContent: "center", width: 34, "& svg": { fontSize: 19 } }}>{icon}</Box>
      <Stack sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 750 }} noWrap>{title}</Typography>
        <Typography color="text.secondary" variant="caption" noWrap>{subtitle}</Typography>
      </Stack>
    </Stack>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <Typography color="text.secondary" variant="body2" sx={{ border: 1, borderColor: "divider", borderRadius: "8px", px: 1.25, py: 1.5 }}>
      {children}
    </Typography>
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
    <Stack spacing={1} sx={{ bgcolor: "background.paper", border: 1, borderColor: "divider", borderRadius: "8px", p: 1.35 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Box sx={{ color: "primary.main", display: "flex", "& svg": { fontSize: 18 } }}>{icon}</Box>
        <Typography variant="body2" sx={{ flex: 1, fontWeight: 700 }}>{label}</Typography>
        <Typography color="text.secondary" sx={{ fontFamily: fontFamilies.mono, fontSize: 12 }}>{value} {unit}</Typography>
      </Stack>
      <Slider size="small" min={min} max={max} step={step} value={sliderValue} onChange={(_, nextValue) => onChange(Array.isArray(nextValue) ? nextValue[0] : nextValue)} />
      <TextField size="small" type="number" value={value} onChange={(event) => onChange(Number(event.target.value) || 0)} inputProps={{ min, step }} fullWidth />
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

function getRuleValidationErrors(rule: ThrottleRule): string[] {
  const errors: string[] = [];
  if (!rule.name.trim()) errors.push("Enter a rule name.");
  if (!rule.profileId) errors.push("Choose a profile.");
  if (!rule.urlPattern.trim()) errors.push("Enter a URL or host pattern.");
  return errors;
}

function formatDelay(delayMs: number): string {
  if (delayMs < 1000) return `${delayMs} ms`;
  return `${(delayMs / 1000).toFixed(1)} s`;
}
