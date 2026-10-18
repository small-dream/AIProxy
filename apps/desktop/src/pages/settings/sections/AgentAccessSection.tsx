import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { open } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  coerceAppError,
  type AgentAccessLimits,
  type AgentAccessPermissions,
  type AgentAccessRedaction,
  type AgentAccessSettings,
  type AgentClientInfo,
  type InstallAgentClientConfigResult,
  type InstallAgentSkillResult,
  type UpdateAgentAccessSettingsInput,
} from "@aiproxy/shared-types";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { SectionCard } from "@/components/shared/SectionCard";
import { AgentAuditTable } from "@/features/agent-access/AgentAuditTable";
import {
  AgentClientRow,
  type AgentClientPendingAction,
} from "@/features/agent-access/AgentClientRow";
import { AgentPathValue } from "@/features/agent-access/AgentPathValue";
import { shouldConfirmConfigWrite } from "@/features/agent-access/agent-access.helpers";
import { useI18n } from "@/i18n";
import {
  getAgentAccessSettings,
  getAgentAuditLog,
  installAgentClientConfig,
  installAgentSkill,
  testAgentAccess,
  updateAgentAccessSettings,
} from "@/services/commands";
import {
  compactAlertSx,
  compactFieldSx,
  rowControlSx,
  SettingsFooter,
  SettingsGroup,
  SettingsRow,
  selectControlSx,
} from "../SettingsLayoutParts";

const AGENT_SETTINGS_QUERY_KEY = ["agent-access-settings"];
const AGENT_AUDIT_QUERY_KEY = ["agent-access-audit"];

type AgentAccessDraft = UpdateAgentAccessSettingsInput;
type FeedbackArea = "client" | "diagnostics" | "permissions" | "settings";

type SaveInput = {
  area: Extract<FeedbackArea, "permissions" | "settings">;
  draft: AgentAccessDraft;
};

type Feedback = {
  area: FeedbackArea;
  severity: "error" | "info" | "success" | "warning";
  message: string;
};

type PendingConfigInstall = {
  info: AgentClientInfo;
  projectDir?: string;
  purpose: "config" | "connect";
};

type PendingSkillOverwrite = {
  backupPath?: string | null;
  configPath?: string;
  info: AgentClientInfo;
  origin: "connect" | "skill";
};

type SkillMutationInput = {
  backupPath?: string | null;
  configPath?: string;
  info: AgentClientInfo;
  origin: "connect" | "skill";
  overwrite: boolean;
};

type ConnectOutcome =
  | {
      kind: "configFailed";
      message: string;
    }
  | {
      config: InstallAgentClientConfigResult;
      kind: "skillFailed";
      message: string;
    }
  | {
      config: InstallAgentClientConfigResult;
      kind: "skillOverwriteRequired";
    }
  | {
      config: InstallAgentClientConfigResult;
      kind: "success";
      skill: InstallAgentSkillResult;
    };

export function AgentAccessSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AgentAccessDraft | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingSkillOverwrite, setPendingSkillOverwrite] = useState<PendingSkillOverwrite | null>(
    null,
  );
  const [pendingConfigInstall, setPendingConfigInstall] = useState<PendingConfigInstall | null>(
    null,
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const settingsQuery = useQuery({
    queryKey: AGENT_SETTINGS_QUERY_KEY,
    queryFn: getAgentAccessSettings,
  });
  const auditQuery = useQuery({
    queryKey: AGENT_AUDIT_QUERY_KEY,
    queryFn: () => getAgentAuditLog(50),
  });

  useEffect(() => {
    if (settingsQuery.data) {
      setDraft((current) => current ?? draftFromSettings(settingsQuery.data));
    }
  }, [settingsQuery.data]);

  function updateClientCache(
    client: AgentClientInfo["client"],
    update: (info: AgentClientInfo) => AgentClientInfo,
  ) {
    queryClient.setQueryData<AgentAccessSettings>(AGENT_SETTINGS_QUERY_KEY, (current) =>
      current
        ? {
            ...current,
            clients: current.clients.map((info) => (info.client === client ? update(info) : info)),
          }
        : current,
    );
  }

  function applyConfigResult(result: InstallAgentClientConfigResult) {
    if (result.client === "claude") return;
    updateClientCache(result.client, (info) => ({
      ...info,
      configExists: true,
      configInstalled: true,
    }));
  }

  function applySkillResult(result: InstallAgentSkillResult) {
    if (result.status === "overwriteRequired") return;
    updateClientCache(result.client, (info) => ({
      ...info,
      skillInstalled: true,
      skillManaged: info.skillManaged || result.status === "installed",
    }));
  }

  const saveMutation = useMutation({
    mutationFn: (input: SaveInput) => updateAgentAccessSettings(input.draft),
    onSuccess: (settings, input) => {
      queryClient.setQueryData(AGENT_SETTINGS_QUERY_KEY, settings);
      setDraft(draftFromSettings(settings));
      setFeedback({
        area: input.area,
        severity: "success",
        message: t("settingsPage.agentAccess.saveSuccess"),
      });
    },
    onError: (error, input) => {
      setFeedback({
        area: input.area,
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const testMutation = useMutation({
    mutationFn: testAgentAccess,
    onSuccess: (result) => {
      setFeedback({
        area: "diagnostics",
        severity: result.ok ? "success" : "error",
        message: result.message,
      });
    },
    onError: (error) => {
      setFeedback({
        area: "diagnostics",
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const connectMutation = useMutation({
    mutationFn: async (input: PendingConfigInstall): Promise<ConnectOutcome> => {
      let config: InstallAgentClientConfigResult;
      try {
        config = await installAgentClientConfig(configInstallInput(input));
      } catch (error) {
        return {
          kind: "configFailed",
          message:
            coerceAppError(error).message || t("settingsPage.agentAccess.configInstallFailed"),
        };
      }

      try {
        const skill = await installAgentSkill({
          client: input.info.client,
          overwrite: false,
        });
        if (skill.status === "overwriteRequired") {
          return { config, kind: "skillOverwriteRequired" };
        }
        return { config, kind: "success", skill };
      } catch (error) {
        return {
          kind: "skillFailed",
          config,
          message: coerceAppError(error).message || t("common.errors.generic"),
        };
      }
    },
    onSuccess: (outcome, input) => {
      setPendingConfigInstall(null);
      if (outcome.kind === "configFailed") {
        setFeedback({ area: "client", severity: "error", message: outcome.message });
        return;
      }

      applyConfigResult(outcome.config);
      if (outcome.kind === "skillFailed") {
        setFeedback({
          area: "client",
          severity: "warning",
          message: t("settingsPage.agentAccess.configWrittenSkillFailed", {
            message: outcome.message,
            path: outcome.config.path,
          }),
        });
        return;
      }
      if (outcome.kind === "skillOverwriteRequired") {
        setPendingSkillOverwrite({
          ...(outcome.config.backupPath ? { backupPath: outcome.config.backupPath } : {}),
          configPath: outcome.config.path,
          info: input.info,
          origin: "connect",
        });
        return;
      }

      applySkillResult(outcome.skill);
      setFeedback({
        area: "client",
        severity: "success",
        message: connectSuccessMessage(outcome, input.info, t),
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const configMutation = useMutation({
    mutationFn: installAgentClientConfig,
    onSuccess: (result) => {
      setPendingConfigInstall(null);
      applyConfigResult(result);
      const message =
        result.status === "upToDate"
          ? t("settingsPage.agentAccess.configInstallUpToDate", { path: result.path })
          : t("settingsPage.agentAccess.configInstallSuccess", { path: result.path });
      setFeedback({
        area: "client",
        severity: "success",
        message: result.backupPath
          ? `${message} ${t("settingsPage.agentAccess.configBackup", { path: result.backupPath })}`
          : message,
      });
    },
    onError: (error) => {
      setPendingConfigInstall(null);
      setFeedback({
        area: "client",
        severity: "error",
        message: coerceAppError(error).message || t("settingsPage.agentAccess.configInstallFailed"),
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const skillMutation = useMutation({
    mutationFn: (input: SkillMutationInput) =>
      installAgentSkill({ client: input.info.client, overwrite: input.overwrite }),
    onSuccess: (result, input) => {
      if (result.status === "overwriteRequired") {
        setPendingSkillOverwrite({
          ...(input.backupPath ? { backupPath: input.backupPath } : {}),
          ...(input.configPath ? { configPath: input.configPath } : {}),
          info: input.info,
          origin: input.origin,
        });
        return;
      }
      setPendingSkillOverwrite(null);
      applySkillResult(result);
      const connectMessage = t("settingsPage.agentAccess.connectSuccess", {
        client: clientName(input.info.client, t),
      });
      setFeedback({
        area: "client",
        severity: "success",
        message:
          input.origin === "connect"
            ? input.backupPath
              ? `${connectMessage} ${t("settingsPage.agentAccess.configBackup", { path: input.backupPath })}`
              : connectMessage
            : result.status === "upToDate"
              ? t("settingsPage.agentAccess.installUpToDate", { path: result.path })
              : t("settingsPage.agentAccess.installSuccess", { path: result.path }),
      });
    },
    onError: (error, input) => {
      setPendingSkillOverwrite(null);
      setFeedback({
        area: "client",
        severity: input.origin === "connect" ? "warning" : "error",
        message:
          input.origin === "connect" && input.configPath
            ? t("settingsPage.agentAccess.configWrittenSkillFailed", {
                message: coerceAppError(error).message || t("common.errors.generic"),
                path: input.configPath,
              })
            : coerceAppError(error).message || t("common.errors.generic"),
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  if (settingsQuery.isLoading || !draft) {
    return (
      <SectionCard compact title={t("settingsPage.agentAccess.title")}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("settingsPage.agentAccess.loading")}
        </Typography>
      </SectionCard>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <SectionCard compact title={t("settingsPage.agentAccess.title")}>
        <Alert severity="error">
          {coerceAppError(settingsQuery.error).message || t("common.errors.generic")}
        </Alert>
      </SectionCard>
    );
  }

  const settings = settingsQuery.data;
  const rawBodiesBlocked = !draft.permissions.readBodies;
  const dirty = !draftsEqual(draft, draftFromSettings(settings));
  const busy =
    saveMutation.isPending ||
    testMutation.isPending ||
    connectMutation.isPending ||
    configMutation.isPending ||
    skillMutation.isPending;
  const activeClient = activeMutationClient(connectMutation, configMutation, skillMutation);
  const activeAction = activeMutationAction(connectMutation, configMutation, skillMutation);

  function updatePermission(key: keyof AgentAccessPermissions, value: boolean) {
    setDraft((current) => {
      if (!current) return current;
      const permissions = { ...current.permissions, [key]: value };
      if (key === "readBodies" && !value) {
        permissions.readRawBodies = false;
      }
      return { ...current, permissions };
    });
  }

  function updateLimit(key: keyof AgentAccessLimits, value: number) {
    setDraft((current) =>
      current ? { ...current, limits: { ...current.limits, [key]: value } } : current,
    );
  }

  function updateRedaction<K extends keyof AgentAccessRedaction>(
    key: K,
    value: AgentAccessRedaction[K],
  ) {
    setDraft((current) =>
      current ? { ...current, redaction: { ...current.redaction, [key]: value } } : current,
    );
  }

  function discardDraft() {
    setDraft(draftFromSettings(settings));
  }

  function saveDraft(area: SaveInput["area"]) {
    if (!draft || !dirty || busy) return;
    saveMutation.mutate({ area, draft });
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({
        area: "client",
        severity: "success",
        message: t("settingsPage.agentAccess.copiedToClipboard"),
      });
    } catch (error) {
      setFeedback({
        area: "client",
        severity: "error",
        message: coerceAppError(error).message || t("settingsPage.agentAccess.copyFailed"),
      });
    }
  }

  async function beginConfigFlow(info: AgentClientInfo, purpose: PendingConfigInstall["purpose"]) {
    if (info.client !== "claude") {
      if (shouldConfirmConfigWrite(info)) {
        setPendingConfigInstall({ info, purpose });
      } else if (purpose === "connect") {
        connectMutation.mutate({ info, purpose });
      } else {
        configMutation.mutate({ client: info.client });
      }
      return;
    }
    try {
      const projectDir = await open({
        directory: true,
        multiple: false,
        title: t("settingsPage.agentAccess.projectPickerTitle"),
      });
      if (typeof projectDir === "string") {
        setPendingConfigInstall({ info, projectDir, purpose });
      }
    } catch (error) {
      setFeedback({
        area: "client",
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    }
  }

  function cancelSkillOverwrite() {
    if (pendingSkillOverwrite?.origin === "connect" && pendingSkillOverwrite.configPath) {
      setFeedback({
        area: "client",
        severity: "warning",
        message: t("settingsPage.agentAccess.configWrittenSkillSkipped", {
          path: pendingSkillOverwrite.configPath,
        }),
      });
    }
    setPendingSkillOverwrite(null);
  }

  return (
    <Stack spacing={2}>
      <Box
        id="settings-item-agent-access"
        data-settings-item="agent-access"
        sx={{ scrollMarginTop: 24 }}
      >
        <SectionCard
          compact
          title={t("settingsPage.agentAccess.title")}
          description={t("settingsPage.agentAccess.description")}
          toolbar={
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexShrink: 0 }}>
              {dirty ? (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={t("settingsPage.agentAccess.unsavedShort")}
                  sx={{ height: 24 }}
                />
              ) : null}
              <Switch
                size="small"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, enabled: event.target.checked } : current,
                  )
                }
                slotProps={{
                  input: { "aria-label": t("settingsPage.agentAccess.enabledLabel") },
                }}
              />
            </Stack>
          }
        >
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <FiberManualRecordRoundedIcon
                sx={{
                  color: settings.sidecarAvailable ? "success.main" : "error.main",
                  fontSize: 10,
                }}
              />
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {settings.sidecarAvailable
                  ? t("settingsPage.agentAccess.sidecarSummary", {
                      version:
                        settings.sidecarVersion ?? t("settingsPage.agentAccess.versionUnknown"),
                    })
                  : t("settingsPage.agentAccess.sidecarUnavailableSummary")}
              </Typography>
            </Stack>

            {!draft.enabled ? (
              <Alert severity="warning" variant="outlined" sx={compactAlertSx}>
                {t("settingsPage.agentAccess.disabledDescription")}
              </Alert>
            ) : null}
            {settings.configError ? (
              <Alert severity="error" variant="outlined" sx={compactAlertSx}>
                {settings.configError}
              </Alert>
            ) : null}
            {feedback?.area === "settings" ? <FeedbackAlert feedback={feedback} /> : null}
            {dirty ? (
              <Alert
                severity="warning"
                variant="outlined"
                sx={{
                  ...compactAlertSx,
                  "& .MuiAlert-action": { alignItems: "center", py: 0 },
                }}
                action={
                  <Stack direction="row" spacing={0.75}>
                    <Button color="inherit" size="small" disabled={busy} onClick={discardDraft}>
                      {t("settingsPage.agentAccess.discardChanges")}
                    </Button>
                    <Button
                      color="warning"
                      size="small"
                      variant="contained"
                      disabled={busy}
                      onClick={() => saveDraft("settings")}
                    >
                      {saveMutation.isPending
                        ? t("settingsPage.agentAccess.saving")
                        : t("settingsPage.agentAccess.saveChanges")}
                    </Button>
                  </Stack>
                }
              >
                {t("settingsPage.agentAccess.unsavedChangesHint")}
              </Alert>
            ) : null}

            <Box>
              <Button
                size="small"
                color="inherit"
                aria-expanded={diagnosticsOpen ? "true" : "false"}
                onClick={() => setDiagnosticsOpen((current) => !current)}
                endIcon={
                  <ExpandMoreRoundedIcon
                    fontSize="small"
                    sx={{
                      transform: diagnosticsOpen ? "rotate(180deg)" : "none",
                      transition: "transform 150ms ease",
                    }}
                  />
                }
                sx={{ color: "text.secondary", minHeight: 32, px: 0.5 }}
              >
                {diagnosticsOpen
                  ? t("settingsPage.agentAccess.hideDiagnostics")
                  : t("settingsPage.agentAccess.diagnostics")}
              </Button>
              <Collapse in={diagnosticsOpen} unmountOnExit>
                <Stack
                  spacing={1}
                  sx={{
                    borderTop: 1,
                    borderColor: "divider",
                    mt: 1,
                    pt: 1.25,
                  }}
                >
                  <AgentPathValue
                    copyLabel={t("settingsPage.agentAccess.copyPath")}
                    label={t("settingsPage.agentAccess.sidecarPathLabel")}
                    onCopy={(value) => void copyText(value)}
                    value={settings.sidecarPath ?? "-"}
                  />
                  <AgentPathValue
                    copyLabel={t("settingsPage.agentAccess.copyPath")}
                    label={t("settingsPage.agentAccess.dataDirLabel")}
                    onCopy={(value) => void copyText(value)}
                    value={settings.dataDir}
                  />
                  <AgentPathValue
                    copyLabel={t("settingsPage.agentAccess.copyPath")}
                    label={t("settingsPage.agentAccess.configPathLabel")}
                    onCopy={(value) => void copyText(value)}
                    value={settings.configPath}
                  />
                  <AgentPathValue
                    copyLabel={t("settingsPage.agentAccess.copyPath")}
                    label={t("settingsPage.agentAccess.auditPathLabel")}
                    onCopy={(value) => void copyText(value)}
                    value={settings.auditPath}
                  />
                  {feedback?.area === "diagnostics" ? <FeedbackAlert feedback={feedback} /> : null}
                  <Box>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<PlayArrowRoundedIcon />}
                      disabled={busy || !settings.sidecarAvailable}
                      onClick={() => testMutation.mutate()}
                      sx={{ minHeight: 34 }}
                    >
                      {testMutation.isPending
                        ? t("settingsPage.agentAccess.testing")
                        : t("settingsPage.agentAccess.test")}
                    </Button>
                  </Box>
                </Stack>
              </Collapse>
            </Box>
          </Stack>
        </SectionCard>
      </Box>

      <SectionCard
        compact
        title={t("settingsPage.agentAccess.clientsTitle")}
        description={t("settingsPage.agentAccess.clientsDescription")}
      >
        <Stack divider={<Divider flexItem />} spacing={0}>
          {settings.clients.map((info) => (
            <AgentClientRow
              key={info.client}
              busy={busy}
              info={info}
              itemId={info.client === "cursor" ? "agent-cursor" : undefined}
              pendingAction={activeClient === info.client ? activeAction : null}
              onConnect={(client) => void beginConfigFlow(client, "connect")}
              onCopyText={(value) => void copyText(value)}
              onInstallSkill={(client) =>
                skillMutation.mutate({ info: client, origin: "skill", overwrite: false })
              }
              onWriteConfig={(client) => void beginConfigFlow(client, "config")}
            />
          ))}
        </Stack>
        {feedback?.area === "client" ? (
          <Box sx={{ mt: 1.5 }}>
            <FeedbackAlert feedback={feedback} />
          </Box>
        ) : null}
      </SectionCard>

      <Box
        id="settings-item-agent-permissions"
        data-settings-item="agent-permissions"
        sx={{ scrollMarginTop: 24 }}
      >
        <SectionCard
          compact
          title={t("settingsPage.agentAccess.permissionsTitle")}
          description={t("settingsPage.agentAccess.permissionsDescription")}
        >
          <SettingsGroup>
            <SettingsRow
              itemId="agent-read-sessions"
              label={t("settingsPage.agentAccess.readSessionsLabel")}
              description={t("settingsPage.agentAccess.readSessionsDescription")}
            >
              <Switch
                size="small"
                checked={draft.permissions.readSessions}
                onChange={(event) => updatePermission("readSessions", event.target.checked)}
                slotProps={{
                  input: { "aria-label": t("settingsPage.agentAccess.readSessionsLabel") },
                }}
              />
            </SettingsRow>
            <SettingsRow
              itemId="agent-read-bodies"
              label={t("settingsPage.agentAccess.readBodiesLabel")}
              description={t("settingsPage.agentAccess.readBodiesDescription")}
            >
              <Switch
                size="small"
                checked={draft.permissions.readBodies}
                onChange={(event) => updatePermission("readBodies", event.target.checked)}
                slotProps={{
                  input: { "aria-label": t("settingsPage.agentAccess.readBodiesLabel") },
                }}
              />
            </SettingsRow>
            <SettingsRow
              itemId="agent-read-websocket"
              label={t("settingsPage.agentAccess.readWebSocketLabel")}
              description={t("settingsPage.agentAccess.readWebSocketDescription")}
            >
              <Switch
                size="small"
                checked={draft.permissions.readWebSocket}
                onChange={(event) => updatePermission("readWebSocket", event.target.checked)}
                slotProps={{
                  input: { "aria-label": t("settingsPage.agentAccess.readWebSocketLabel") },
                }}
              />
            </SettingsRow>
          </SettingsGroup>

          <Divider sx={{ mt: 1 }} />
          <Box sx={{ pt: 1.5 }}>
            <Button
              size="small"
              color="inherit"
              aria-expanded={advancedOpen ? "true" : "false"}
              onClick={() => setAdvancedOpen((current) => !current)}
              endIcon={
                <ExpandMoreRoundedIcon
                  fontSize="small"
                  sx={{
                    transform: advancedOpen ? "rotate(180deg)" : "none",
                    transition: "transform 150ms ease",
                  }}
                />
              }
              sx={{ color: "text.primary", minHeight: 32, px: 0.5 }}
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <span>{t("settingsPage.agentAccess.advancedPermissions")}</span>
                {draft.permissions.readRawBodies ? (
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    label={t("settingsPage.agentAccess.rawBodiesEnabled")}
                    sx={{ height: 22, "& .MuiChip-label": { px: 0.75, fontSize: 11.5 } }}
                  />
                ) : null}
              </Stack>
            </Button>
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", display: "block", mt: 0.25, px: 0.5 }}
            >
              {t("settingsPage.agentAccess.advancedPermissionsDescription")}
            </Typography>
            <Collapse in={advancedOpen} unmountOnExit>
              <Box sx={{ pt: 1.5 }}>
                <SettingsGroup>
                  <SettingsRow
                    itemId="agent-read-raw-bodies"
                    label={t("settingsPage.agentAccess.readRawBodiesLabel")}
                    description={t("settingsPage.agentAccess.readRawBodiesDescription")}
                  >
                    <Switch
                      size="small"
                      color="warning"
                      checked={draft.permissions.readRawBodies}
                      disabled={rawBodiesBlocked}
                      onChange={(event) => updatePermission("readRawBodies", event.target.checked)}
                      slotProps={{
                        input: {
                          "aria-label": t("settingsPage.agentAccess.readRawBodiesLabel"),
                        },
                      }}
                    />
                  </SettingsRow>
                  <SettingsRow
                    itemId="agent-detect-sensitive-values"
                    label={t("settingsPage.agentAccess.detectSensitiveValuesLabel")}
                    description={t("settingsPage.agentAccess.detectSensitiveValuesDescription")}
                  >
                    <Switch
                      size="small"
                      checked={draft.redaction.detectSensitiveValues}
                      onChange={(event) =>
                        updateRedaction("detectSensitiveValues", event.target.checked)
                      }
                      slotProps={{
                        input: {
                          "aria-label": t("settingsPage.agentAccess.detectSensitiveValuesLabel"),
                        },
                      }}
                    />
                  </SettingsRow>
                  <SettingsRow
                    itemId="agent-hash-identifiers"
                    label={t("settingsPage.agentAccess.hashIdentifiersLabel")}
                    description={t("settingsPage.agentAccess.hashIdentifiersDescription")}
                  >
                    <Switch
                      size="small"
                      checked={draft.redaction.hashIdentifiers}
                      disabled={!draft.redaction.detectSensitiveValues}
                      onChange={(event) => updateRedaction("hashIdentifiers", event.target.checked)}
                      slotProps={{
                        input: {
                          "aria-label": t("settingsPage.agentAccess.hashIdentifiersLabel"),
                        },
                      }}
                    />
                  </SettingsRow>
                  <SettingsRow
                    itemId="agent-custom-sensitive-keys"
                    label={t("settingsPage.agentAccess.customSensitiveKeysLabel")}
                    description={t("settingsPage.agentAccess.customSensitiveKeysDescription")}
                  >
                    <Autocomplete
                      multiple
                      freeSolo
                      size="small"
                      options={[] as string[]}
                      value={draft.redaction.customSensitiveKeys}
                      disabled={!draft.redaction.detectSensitiveValues}
                      onChange={(_, value) =>
                        updateRedaction(
                          "customSensitiveKeys",
                          Array.from(
                            new Set(value.map((item) => item.trim().toLowerCase()).filter(Boolean)),
                          ),
                        )
                      }
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          placeholder={t("settingsPage.agentAccess.customSensitiveKeysPlaceholder")}
                          sx={{ ...rowControlSx, ...compactFieldSx }}
                        />
                      )}
                    />
                  </SettingsRow>
                  <SettingsRow
                    itemId="agent-max-sessions"
                    label={t("settingsPage.agentAccess.maxSessionsLabel")}
                    description={t("settingsPage.agentAccess.maxSessionsDescription")}
                  >
                    <Select
                      size="small"
                      value={draft.limits.maxSessions}
                      onChange={(event) => updateLimit("maxSessions", Number(event.target.value))}
                      inputProps={{ "aria-label": t("settingsPage.agentAccess.maxSessionsLabel") }}
                      sx={selectControlSx}
                    >
                      {[20, 50, 100].map((value) => (
                        <MenuItem key={value} value={value}>
                          {value}
                        </MenuItem>
                      ))}
                    </Select>
                  </SettingsRow>
                  <SettingsRow
                    itemId="agent-max-body-bytes"
                    label={t("settingsPage.agentAccess.maxBodyBytesLabel")}
                    description={t("settingsPage.agentAccess.maxBodyBytesDescription")}
                  >
                    <Select
                      size="small"
                      value={draft.limits.maxBodyBytes}
                      onChange={(event) => updateLimit("maxBodyBytes", Number(event.target.value))}
                      inputProps={{ "aria-label": t("settingsPage.agentAccess.maxBodyBytesLabel") }}
                      sx={selectControlSx}
                    >
                      {[64, 128, 256].map((kib) => (
                        <MenuItem key={kib} value={kib * 1024}>
                          {`${kib} KiB`}
                        </MenuItem>
                      ))}
                    </Select>
                  </SettingsRow>
                </SettingsGroup>
                {draft.permissions.readRawBodies ? (
                  <Alert severity="warning" variant="outlined" sx={{ ...compactAlertSx, mt: 1 }}>
                    {t("settingsPage.agentAccess.rawBodiesWarning")}
                  </Alert>
                ) : null}
              </Box>
            </Collapse>
          </Box>

          <SettingsFooter
            hint={
              dirty ? (
                <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                  <WarningAmberRoundedIcon color="warning" sx={{ fontSize: 18 }} />
                  <Typography variant="caption" sx={{ color: "warning.main" }}>
                    {t("settingsPage.agentAccess.unsavedChangesHint")}
                  </Typography>
                </Stack>
              ) : (
                t("settingsPage.agentAccess.saveHint")
              )
            }
          >
            {dirty ? (
              <Button size="small" disabled={busy} onClick={discardDraft}>
                {t("settingsPage.agentAccess.discardChanges")}
              </Button>
            ) : null}
            <Button
              size="small"
              variant="contained"
              disabled={!dirty || busy}
              onClick={() => saveDraft("permissions")}
              sx={{ minHeight: 34, px: 1.75 }}
            >
              {saveMutation.isPending
                ? t("settingsPage.agentAccess.saving")
                : t("settingsPage.agentAccess.saveChanges")}
            </Button>
          </SettingsFooter>
          {feedback?.area === "permissions" ? (
            <Box sx={{ pb: 1.5 }}>
              <FeedbackAlert feedback={feedback} />
            </Box>
          ) : null}
        </SectionCard>
      </Box>

      <Box
        id="settings-item-agent-audit"
        data-settings-item="agent-audit"
        sx={{ scrollMarginTop: 24 }}
      >
        <AgentAuditTable
          data={auditQuery.data}
          loading={auditQuery.isFetching}
          onRefresh={() => void auditQuery.refetch()}
        />
      </Box>

      <Alert severity="info" variant="outlined" sx={compactAlertSx}>
        {t("settingsPage.agentAccess.securityNote")}
      </Alert>

      <ConfirmDialog
        open={pendingConfigInstall !== null}
        title={t("settingsPage.agentAccess.configInstallTitle")}
        message={t("settingsPage.agentAccess.configInstallMessage", {
          path:
            pendingConfigInstall?.info.client === "claude"
              ? `${pendingConfigInstall.projectDir ?? ""}/.mcp.json`
              : (pendingConfigInstall?.info.configPath ?? ""),
        })}
        confirmLabel={t("settingsPage.agentAccess.configInstallConfirm")}
        isConfirming={connectMutation.isPending || configMutation.isPending}
        onCancel={() => setPendingConfigInstall(null)}
        onConfirm={() => {
          if (!pendingConfigInstall) return;
          if (pendingConfigInstall.purpose === "connect") {
            connectMutation.mutate(pendingConfigInstall);
          } else {
            configMutation.mutate(configInstallInput(pendingConfigInstall));
          }
        }}
      />

      <ConfirmDialog
        open={pendingSkillOverwrite !== null}
        title={t("settingsPage.agentAccess.overwriteTitle")}
        message={t("settingsPage.agentAccess.overwriteMessage", {
          path: pendingSkillOverwrite?.info.skillPath ?? "",
        })}
        confirmColor="warning"
        confirmLabel={t("settingsPage.agentAccess.overwriteConfirm")}
        isConfirming={skillMutation.isPending}
        onCancel={cancelSkillOverwrite}
        onConfirm={() => {
          if (!pendingSkillOverwrite) return;
          skillMutation.mutate({
            ...(pendingSkillOverwrite.backupPath
              ? { backupPath: pendingSkillOverwrite.backupPath }
              : {}),
            ...(pendingSkillOverwrite.configPath
              ? { configPath: pendingSkillOverwrite.configPath }
              : {}),
            info: pendingSkillOverwrite.info,
            origin: pendingSkillOverwrite.origin,
            overwrite: true,
          });
        }}
      />
    </Stack>
  );
}

function FeedbackAlert({ feedback }: { feedback: Feedback }) {
  return (
    <Alert severity={feedback.severity} variant="outlined" sx={compactAlertSx}>
      {feedback.message}
    </Alert>
  );
}

function configInstallInput(input: PendingConfigInstall) {
  return {
    client: input.info.client,
    ...(input.projectDir ? { projectDir: input.projectDir } : {}),
  };
}

function connectSuccessMessage(
  outcome: Extract<ConnectOutcome, { kind: "success" }>,
  info: AgentClientInfo,
  t: ReturnType<typeof useI18n>["t"],
) {
  const message = t("settingsPage.agentAccess.connectSuccess", {
    client: clientName(info.client, t),
  });
  return outcome.config.backupPath
    ? `${message} ${t("settingsPage.agentAccess.configBackup", { path: outcome.config.backupPath })}`
    : message;
}

function clientName(client: AgentClientInfo["client"], t: ReturnType<typeof useI18n>["t"]) {
  switch (client) {
    case "codex":
      return t("settingsPage.agentAccess.clientCodex");
    case "claude":
      return t("settingsPage.agentAccess.clientClaude");
    case "cursor":
      return t("settingsPage.agentAccess.clientCursor");
  }
}

function activeMutationClient(
  connectMutation: { isPending: boolean; variables?: PendingConfigInstall | undefined },
  configMutation: {
    isPending: boolean;
    variables?: { client: AgentClientInfo["client"] } | undefined;
  },
  skillMutation: { isPending: boolean; variables?: SkillMutationInput | undefined },
) {
  if (connectMutation.isPending) return connectMutation.variables?.info.client ?? null;
  if (configMutation.isPending) return configMutation.variables?.client ?? null;
  if (skillMutation.isPending) return skillMutation.variables?.info.client ?? null;
  return null;
}

function activeMutationAction(
  connectMutation: { isPending: boolean },
  configMutation: { isPending: boolean },
  skillMutation: { isPending: boolean },
): AgentClientPendingAction | null {
  if (connectMutation.isPending) return "connect";
  if (configMutation.isPending) return "config";
  if (skillMutation.isPending) return "skill";
  return null;
}

function draftFromSettings(settings: AgentAccessSettings): AgentAccessDraft {
  return {
    enabled: settings.enabled,
    permissions: { ...settings.permissions },
    limits: { ...settings.limits },
    redaction: {
      ...settings.redaction,
      customSensitiveKeys: [...settings.redaction.customSensitiveKeys],
      customPatterns: settings.redaction.customPatterns.map((rule) => ({ ...rule })),
    },
  };
}

function draftsEqual(current: AgentAccessDraft, saved: AgentAccessDraft) {
  if (current.enabled !== saved.enabled) return false;
  const permissionKeys: Array<keyof AgentAccessPermissions> = [
    "readSessions",
    "readBodies",
    "readRawBodies",
    "readWebSocket",
    "exportSnapshots",
  ];
  const limitKeys: Array<keyof AgentAccessLimits> = [
    "maxSessions",
    "maxBodyBytes",
    "maxResponseBytes",
  ];
  return (
    permissionKeys.every((key) => current.permissions[key] === saved.permissions[key]) &&
    limitKeys.every((key) => current.limits[key] === saved.limits[key]) &&
    JSON.stringify(current.redaction) === JSON.stringify(saved.redaction)
  );
}
