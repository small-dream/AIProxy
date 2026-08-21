import AddRoundedIcon from "@mui/icons-material/AddRounded";
import PowerSettingsNewRoundedIcon from "@mui/icons-material/PowerSettingsNewRounded";
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
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  alpha,
} from "@mui/material";
import { useState } from "react";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { ProfileEditor } from "@/features/throttling/components/ProfileEditor";
import { RuleEditor } from "@/features/throttling/components/RuleEditor";
import { formatDelay, useThrottleEditor } from "@/features/throttling/use-throttle-editor";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

export function ThrottlingPage() {
  const { t } = useI18n();
  const ed = useThrottleEditor();
  // Destructive delete is confirmed first; the target drives the dialog copy.
  const [deleteRuleConfirm, setDeleteRuleConfirm] = useState<{
    id: string;
    name: string;
  } | null>(null);

  return (
    <Stack spacing={1} sx={{ height: "100%", minHeight: 0 }}>
      {(ed.isProfilesError || ed.isRulesError) && (
        <Alert severity="error">{t("common.errors.generic")}</Alert>
      )}
      <Paper elevation={0} variant="outlined" sx={{ borderRadius: "8px", overflow: "hidden" }}>
        <Box sx={{ px: 1.5, py: 1.25 }}>
          <Stack
            direction={{ xs: "column", lg: "row" }}
            spacing={1.25}
            sx={{
              alignItems: { xs: "stretch", lg: "center" },
            }}
          >
            <Stack
              direction="row"
              spacing={1}
              sx={{
                alignItems: "center",
                flex: 1,
                minWidth: 0,
              }}
            >
              <Box
                sx={{
                  color: ed.activeProfile ? "success.main" : "text.secondary",
                  display: "flex",
                }}
              >
                <WifiTetheringRoundedIcon fontSize="small" />
              </Box>
              <Stack sx={{ minWidth: 0 }}>
                <Stack
                  direction="row"
                  spacing={0.75}
                  sx={{
                    alignItems: "center",
                  }}
                >
                  <Typography variant="subtitle2" sx={{ fontWeight: 750 }} noWrap>
                    {t("throttlingPage.title")}
                  </Typography>
                  <Chip
                    size="small"
                    color={ed.activeProfile ? "success" : "default"}
                    label={ed.activeProfile ? t("throttlingPage.on") : t("throttlingPage.off")}
                    sx={{ height: 20, fontSize: 11 }}
                  />
                  {ed.temporaryUntil ? (
                    <Chip
                      size="small"
                      icon={<TimerOutlinedIcon />}
                      label={`${Math.ceil(ed.temporaryRemaining / 60000)} min`}
                      sx={{ height: 20, fontSize: 11 }}
                    />
                  ) : null}
                </Stack>
                <Typography
                  variant="caption"
                  noWrap
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {ed.activeStatusLabel}{" "}
                  {t("throttlingPage.activeStatusScope", {
                    activeRuleCount: ed.activeRuleCount,
                    ruleLabel:
                      ed.activeRuleCount === 1 ? t("common.labels.rule") : t("common.labels.rules"),
                  })}
                </Typography>
              </Stack>
            </Stack>

            <Stack
              direction="row"
              spacing={0.75}
              useFlexGap
              sx={{
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <StatusPill
                icon={<RuleRoundedIcon />}
                label={t("throttlingPage.stats.hits")}
                value={String(ed.stats?.matchedRequests ?? 0)}
              />
              <StatusPill
                icon={<SignalCellularAltRoundedIcon />}
                label={t("throttlingPage.stats.drops")}
                value={String(ed.stats?.droppedRequests ?? 0)}
              />
              <StatusPill
                icon={<SpeedRoundedIcon />}
                label={t("throttlingPage.stats.delay")}
                value={`${formatDelay((ed.stats?.requestDelayMs ?? 0) + (ed.stats?.responseDelayMs ?? 0))}`}
              />
              <Button
                size="small"
                variant="outlined"
                startIcon={<TimerOutlinedIcon />}
                onClick={() => ed.handleTemporaryEnable()}
                disabled={ed.profiles.length === 0 || ed.setActivePending}
              >
                15 min
              </Button>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                startIcon={<PowerSettingsNewRoundedIcon />}
                onClick={ed.handleDisableGlobal}
                disabled={!ed.activeProfile || ed.setActivePending}
              >
                {t("throttlingPage.disableGlobal")}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Paper>
      <Box
        sx={{
          display: "grid",
          gap: 1,
          gridTemplateColumns: { xs: "1fr", xl: "380px minmax(0, 1fr)" },
          minHeight: 0,
          flex: 1,
        }}
      >
        <Paper
          elevation={0}
          variant="outlined"
          sx={{
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: "center",
              borderBottom: 1,
              borderColor: "divider",
              px: 1.25,
              py: 1,
            }}
          >
            <ToggleButtonGroup
              exclusive
              size="small"
              value={ed.mode}
              onChange={(_, value) => value && ed.setMode(value)}
              sx={{ flex: 1, "& .MuiToggleButton-root": { flex: 1, py: 0.45 } }}
            >
              <ToggleButton value="profiles">{t("throttlingPage.tabs.profiles")}</ToggleButton>
              <ToggleButton value="rules">{t("throttlingPage.tabs.rules")}</ToggleButton>
            </ToggleButtonGroup>
          </Stack>

          <Box sx={{ minHeight: 0, overflow: "auto", p: 1 }}>
            {ed.mode === "profiles" ? (
              <Stack spacing={1}>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{
                    alignItems: "center",
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      flex: 1,
                      fontWeight: 700,
                      textTransform: "uppercase",
                    }}
                  >
                    {t("throttlingPage.presetsTitle")}
                  </Typography>
                  <Button size="small" startIcon={<AddRoundedIcon />} onClick={ed.handleNewProfile}>
                    {t("throttlingPage.newProfile")}
                  </Button>
                </Stack>
                <ProfileList
                  profiles={ed.presetProfiles}
                  activeProfileId={ed.activeProfile?.id}
                  selectedProfileId={ed.selectedProfileId}
                  onApply={(profile) => ed.handleTemporaryEnable(profile.id)}
                  onSelect={ed.selectProfile}
                />
                <Divider />
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    fontWeight: 700,
                    textTransform: "uppercase",
                  }}
                >
                  {t("throttlingPage.customTitle")}
                </Typography>
                {ed.customProfiles.length === 0 ? (
                  <EmptyHint>{t("throttlingPage.customEmpty")}</EmptyHint>
                ) : (
                  <ProfileList
                    profiles={ed.customProfiles}
                    activeProfileId={ed.activeProfile?.id}
                    selectedProfileId={ed.selectedProfileId}
                    onApply={(profile) => ed.handleTemporaryEnable(profile.id)}
                    onSelect={ed.selectProfile}
                  />
                )}
              </Stack>
            ) : (
              <Stack spacing={1}>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{
                    alignItems: "center",
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      flex: 1,
                      fontWeight: 700,
                      textTransform: "uppercase",
                    }}
                  >
                    {t("throttlingPage.rulesTitle")}
                  </Typography>
                  <Button
                    size="small"
                    startIcon={<AddRoundedIcon />}
                    onClick={ed.handleNewRule}
                    disabled={ed.profiles.length === 0}
                  >
                    {t("throttlingPage.newRule")}
                  </Button>
                </Stack>
                {ed.rules.length === 0 ? (
                  <EmptyHint>{t("throttlingPage.rulesEmptyHint")}</EmptyHint>
                ) : (
                  <List
                    dense
                    disablePadding
                    sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}
                  >
                    {[...ed.rules]
                      .sort((a, b) => b.priority - a.priority)
                      .map((rule) => (
                        <ListItemButton
                          key={rule.id}
                          selected={rule.id === ed.selectedRuleId}
                          onClick={() => {
                            ed.setSelectedRuleId(rule.id);
                            ed.setRuleDraft(rule);
                          }}
                          sx={{
                            border: 1,
                            borderColor: rule.id === ed.selectedRuleId ? "primary.main" : "divider",
                            borderRadius: "8px",
                            px: 1.25,
                          }}
                        >
                          <RuleRoundedIcon
                            sx={{
                              color: rule.enabled ? "primary.main" : "text.secondary",
                              fontSize: 18,
                              mr: 1,
                            }}
                          />
                          <ListItemText
                            primary={
                              <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                                {rule.name}
                              </Typography>
                            }
                            secondary={`${rule.urlPattern} • ${rule.methods.length ? rule.methods.join(", ") : t("throttlingPage.anyMethod")} • ${rule.stage}`}
                            slotProps={{ secondary: { noWrap: true, sx: { fontSize: 11.5 } } }}
                          />
                          {/* Review §4.1: inline toggle persists immediately
                              (the saved rule, not the in-flight draft). */}
                          <Switch
                            size="small"
                            checked={rule.enabled}
                            onChange={(event) => {
                              event.stopPropagation();
                              ed.toggleRuleEnabled(rule, event.target.checked);
                            }}
                            onClick={(event) => event.stopPropagation()}
                            slotProps={{
                              input: {
                                "aria-label": `${t("throttlingPage.ruleFields.enabled")}: ${rule.name}`,
                              },
                            }}
                            sx={{ mr: 0.5 }}
                          />
                          <Chip
                            size="small"
                            label={rule.priority}
                            sx={{ height: 20, fontSize: 11 }}
                          />
                        </ListItemButton>
                      ))}
                  </List>
                )}
              </Stack>
            )}
          </Box>
        </Paper>

        <Paper
          elevation={0}
          variant="outlined"
          sx={{ borderRadius: "8px", minHeight: 0, overflow: "auto", p: 1.5 }}
        >
          {ed.mode === "profiles" && ed.profileSaveError ? (
            <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>
              {ed.profileSaveError}
            </Alert>
          ) : null}
          {ed.mode === "rules" && ed.ruleSaveError ? (
            <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>
              {ed.ruleSaveError}
            </Alert>
          ) : null}
          {ed.mode === "profiles" ? (
            <ProfileEditor
              active={ed.activeProfile?.id === ed.profileDraft.id}
              canSave={!ed.saveProfilePending && !ed.isProfilesError}
              draft={ed.profileDraft}
              errors={ed.profileErrors}
              onChange={ed.setProfileDraft}
              onSave={() => ed.handleSaveProfile(false)}
              onSaveAndApply={() => ed.handleSaveProfile(true)}
              t={t}
              validationAttempted={ed.validationAttempted}
            />
          ) : (
            <RuleEditor
              draft={ed.ruleDraft}
              errors={ed.ruleErrors}
              isError={ed.isRulesError}
              profiles={ed.profiles}
              t={t}
              onChange={ed.updateRuleDraft}
              onDuplicate={ed.duplicateRule}
              onDelete={(id) =>
                setDeleteRuleConfirm({
                  id,
                  name:
                    ed.ruleDraft?.name.trim() ||
                    ed.ruleDraft?.urlPattern ||
                    t("throttlingPage.deleteRuleTitle"),
                })
              }
              onSave={ed.handleSaveRule}
              saving={ed.saveRulePending || ed.isRulesError}
              validationAttempted={ed.validationAttempted}
            />
          )}
        </Paper>
      </Box>

      <ConfirmDialog
        open={deleteRuleConfirm !== null}
        title={t("throttlingPage.deleteRuleTitle")}
        message={t("common.confirmDeleteMessage", {
          name: deleteRuleConfirm?.name ?? "",
        })}
        onConfirm={() => {
          if (!deleteRuleConfirm) return;
          ed.handleDeleteRule(deleteRuleConfirm.id);
          setDeleteRuleConfirm(null);
        }}
        onCancel={() => setDeleteRuleConfirm(null)}
        isConfirming={ed.deleteRulePending}
      />
    </Stack>
  );
}

function StatusPill({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Stack
      direction="row"
      spacing={0.65}
      sx={{
        alignItems: "center",
        bgcolor: "action.hover",
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        minHeight: 30,
        px: 1,
      }}
    >
      <Box sx={{ color: "text.secondary", display: "flex", "& svg": { fontSize: 16 } }}>{icon}</Box>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
        {label}
      </Typography>
      <Typography sx={{ fontFamily: fontFamilies.mono, fontSize: 12.5, fontWeight: 700 }}>
        {value}
      </Typography>
    </Stack>
  );
}

function ProfileList(props: {
  activeProfileId: string | undefined;
  onApply: (profile: ThrottleProfile) => void;
  onSelect: (profile: ThrottleProfile) => void;
  profiles: ThrottleProfile[];
  selectedProfileId: string | undefined;
}) {
  const { t } = useI18n();
  const { activeProfileId, onApply, profiles, selectedProfileId } = props;

  return (
    <List dense disablePadding sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      {profiles.map((profile) => (
        <ListItemButton
          key={profile.id}
          selected={selectedProfileId === profile.id}
          onClick={() => props.onSelect(profile)}
          sx={(theme) => ({
            border: 1,
            borderColor: selectedProfileId === profile.id ? "primary.main" : "divider",
            borderRadius: "8px",
            px: 1.25,
            py: 0.9,
            "&.Mui-selected": {
              bgcolor: alpha(
                theme.palette.primary.main,
                theme.palette.mode === "dark" ? 0.18 : 0.07,
              ),
            },
          })}
        >
          <Box
            sx={{
              color: profile.enabled ? "success.main" : "text.secondary",
              display: "flex",
              mr: 1,
            }}
          >
            {profile.name.toLowerCase().includes("wifi") ? (
              <WifiTetheringRoundedIcon sx={{ fontSize: 18 }} />
            ) : (
              <SignalCellularAltRoundedIcon sx={{ fontSize: 18 }} />
            )}
          </Box>
          <ListItemText
            primary={
              <Stack
                direction="row"
                spacing={0.5}
                sx={{
                  alignItems: "center",
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                  {profile.name}
                </Typography>
                {activeProfileId === profile.id ? (
                  <Chip
                    size="small"
                    color="success"
                    label={t("throttlingPage.activeChip")}
                    sx={{ height: 18, fontSize: 10 }}
                  />
                ) : null}
              </Stack>
            }
            secondary={t("throttlingPage.profileSummary", {
              latency: profile.latencyMs,
              download: profile.downloadKbps,
              upload: profile.uploadKbps,
              loss: profile.packetLossRatio,
            })}
            slotProps={{ secondary: { noWrap: true, sx: { fontSize: 11.5 } } }}
          />
          <Button
            size="small"
            variant={activeProfileId === profile.id ? "contained" : "outlined"}
            onClick={(event) => {
              event.stopPropagation();
              onApply(profile);
            }}
            sx={{ minWidth: 58 }}
          >
            {t("throttlingPage.applyPreset")}
          </Button>
        </ListItemButton>
      ))}
    </List>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="body2"
      sx={{
        color: "text.secondary",
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        px: 1.25,
        py: 1.5,
      }}
    >
      {children}
    </Typography>
  );
}

type ThrottleProfile = import("@aiproxy/shared-types").ThrottleProfile;
