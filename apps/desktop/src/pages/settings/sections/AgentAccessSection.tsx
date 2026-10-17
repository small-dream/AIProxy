import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { open } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  coerceAppError,
  type AgentAccessPermissions,
  type AgentAccessSettings,
  type AgentClientInfo,
  type InstallAgentSkillStatus,
  type UpdateAgentAccessSettingsInput,
} from "@aiproxy/shared-types";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { SectionCard } from "@/components/shared/SectionCard";
import { AgentAuditTable } from "@/features/agent-access/AgentAuditTable";
import { AgentClientConfigCard } from "@/features/agent-access/AgentClientConfigCard";
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
  SettingsFooter,
  SettingsGroup,
  SettingsRow,
  selectControlSx,
} from "../SettingsLayoutParts";

const AGENT_SETTINGS_QUERY_KEY = ["agent-access-settings"];
const AGENT_AUDIT_QUERY_KEY = ["agent-access-audit"];

type AgentAccessDraft = UpdateAgentAccessSettingsInput;

type Feedback = {
  severity: "error" | "info" | "success" | "warning";
  message: string;
};

type PendingConfigInstall = {
  info: AgentClientInfo;
  projectDir?: string;
};

export function shouldConfirmConfigWrite(info: AgentClientInfo) {
  return info.client === "claude" || info.configExists;
}

export function AgentAccessSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AgentAccessDraft | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingInstall, setPendingInstall] = useState<AgentClientInfo | null>(null);
  const [pendingConfigInstall, setPendingConfigInstall] = useState<PendingConfigInstall | null>(
    null,
  );
  const [installStatus, setInstallStatus] = useState<
    Partial<Record<AgentClientInfo["client"], InstallAgentSkillStatus>>
  >({});

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
      setDraft(draftFromSettings(settingsQuery.data));
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: updateAgentAccessSettings,
    onSuccess: (settings) => {
      queryClient.setQueryData(AGENT_SETTINGS_QUERY_KEY, settings);
      setDraft(draftFromSettings(settings));
      setFeedback({ severity: "success", message: t("settingsPage.agentAccess.saveSuccess") });
    },
    onError: (error) => {
      setFeedback({
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
        severity: result.ok ? "success" : "error",
        message: result.message,
      });
    },
    onError: (error) => {
      setFeedback({
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const installMutation = useMutation({
    mutationFn: (input: { info: AgentClientInfo; overwrite: boolean }) =>
      installAgentSkill({ client: input.info.client, overwrite: input.overwrite }),
    onSuccess: (result, input) => {
      setInstallStatus((current) => ({ ...current, [result.client]: result.status }));
      if (result.status === "overwriteRequired") {
        setPendingInstall(input.info);
        return;
      }
      setPendingInstall(null);
      queryClient.setQueryData<AgentAccessSettings>(AGENT_SETTINGS_QUERY_KEY, (current) =>
        current
          ? {
              ...current,
              clients: current.clients.map((client) =>
                client.client === result.client
                  ? {
                      ...client,
                      skillInstalled: result.status === "installed" || client.skillInstalled,
                      skillManaged: result.status === "installed" || client.skillManaged,
                    }
                  : client,
              ),
            }
          : current,
      );
      setFeedback({
        severity: "success",
        message:
          result.status === "upToDate"
            ? t("settingsPage.agentAccess.installUpToDate", { path: result.path })
            : t("settingsPage.agentAccess.installSuccess", { path: result.path }),
      });
    },
    onError: (error) => {
      setPendingInstall(null);
      setFeedback({
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const installConfigMutation = useMutation({
    mutationFn: installAgentClientConfig,
    onSuccess: (result) => {
      setPendingConfigInstall(null);
      void queryClient.invalidateQueries({ queryKey: AGENT_SETTINGS_QUERY_KEY });
      const message =
        result.status === "upToDate"
          ? t("settingsPage.agentAccess.configInstallUpToDate", { path: result.path })
          : t("settingsPage.agentAccess.configInstallSuccess", { path: result.path });
      setFeedback({
        severity: "success",
        message: result.backupPath
          ? `${message} ${t("settingsPage.agentAccess.configBackup", { path: result.backupPath })}`
          : message,
      });
    },
    onError: (error) => {
      setPendingConfigInstall(null);
      setFeedback({
        severity: "error",
        message: coerceAppError(error).message || t("settingsPage.agentAccess.configInstallFailed"),
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
  const busy =
    saveMutation.isPending ||
    testMutation.isPending ||
    installMutation.isPending ||
    installConfigMutation.isPending;

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

  async function copyConfig(info: AgentClientInfo) {
    try {
      await navigator.clipboard.writeText(info.configSnippet);
      setFeedback({ severity: "success", message: t("settingsPage.agentAccess.configCopied") });
    } catch (error) {
      setFeedback({
        severity: "error",
        message: coerceAppError(error).message || t("settingsPage.agentAccess.copyFailed"),
      });
    }
  }

  async function beginConfigInstall(info: AgentClientInfo) {
    if (info.client !== "claude") {
      if (shouldConfirmConfigWrite(info)) {
        setPendingConfigInstall({ info });
      } else {
        installConfigMutation.mutate({ client: info.client });
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
        setPendingConfigInstall({ info, projectDir });
      }
    } catch (error) {
      setFeedback({
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    }
  }

  return (
    <Stack spacing={2}>
      <SectionCard
        compact
        title={t("settingsPage.agentAccess.statusTitle")}
        description={t("settingsPage.agentAccess.statusDescription")}
        toolbar={
          <Switch
            size="small"
            checked={draft.enabled}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, enabled: event.target.checked } : current,
              )
            }
            slotProps={{ input: { "aria-label": t("settingsPage.agentAccess.enabledLabel") } }}
          />
        }
      >
        <Stack spacing={1.5}>
          <Alert
            severity={draft.enabled ? "info" : "warning"}
            variant="outlined"
            sx={compactAlertSx}
            icon={draft.enabled ? <CheckCircleRoundedIcon /> : <WarningAmberRoundedIcon />}
          >
            {draft.enabled
              ? t("settingsPage.agentAccess.enabledDescription")
              : t("settingsPage.agentAccess.disabledDescription")}
          </Alert>

          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Chip
              size="small"
              color={settings.sidecarAvailable ? "success" : "error"}
              variant="outlined"
              label={
                settings.sidecarAvailable
                  ? t("settingsPage.agentAccess.sidecarReady")
                  : t("settingsPage.agentAccess.sidecarMissing")
              }
            />
            <Chip
              size="small"
              color={settings.configExists ? "success" : "default"}
              variant="outlined"
              label={
                settings.configExists
                  ? t("settingsPage.agentAccess.configReady")
                  : t("settingsPage.agentAccess.configMissing")
              }
            />
            <Chip
              size="small"
              color="default"
              variant="outlined"
              label={settings.sidecarVersion ?? t("settingsPage.agentAccess.versionUnknown")}
            />
          </Stack>

          {settings.configError ? (
            <Alert severity="error" variant="outlined" sx={compactAlertSx}>
              {settings.configError}
            </Alert>
          ) : null}

          <PathRow
            label={t("settingsPage.agentAccess.sidecarPathLabel")}
            value={settings.sidecarPath ?? "-"}
          />
          <PathRow label={t("settingsPage.agentAccess.dataDirLabel")} value={settings.dataDir} />
          <PathRow
            label={t("settingsPage.agentAccess.configPathLabel")}
            value={settings.configPath}
          />
          <PathRow
            label={t("settingsPage.agentAccess.auditPathLabel")}
            value={settings.auditPath}
          />

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
      </SectionCard>

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
            />
          </SettingsRow>
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
            />
          </SettingsRow>
          <SettingsRow
            itemId="agent-export-snapshots"
            label={t("settingsPage.agentAccess.exportSnapshotsLabel")}
            description={t("settingsPage.agentAccess.exportSnapshotsDescription")}
          >
            <Switch size="small" checked={false} disabled />
          </SettingsRow>
          <SettingsRow
            itemId="agent-max-sessions"
            label={t("settingsPage.agentAccess.maxSessionsLabel")}
            description={t("settingsPage.agentAccess.maxSessionsDescription")}
          >
            <Select
              size="small"
              value={draft.limits.maxSessions}
              onChange={(event) =>
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        limits: { ...current.limits, maxSessions: Number(event.target.value) },
                      }
                    : current,
                )
              }
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
              onChange={(event) =>
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        limits: { ...current.limits, maxBodyBytes: Number(event.target.value) },
                      }
                    : current,
                )
              }
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

        <SettingsFooter hint={t("settingsPage.agentAccess.saveHint")}>
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            onClick={() => saveMutation.mutate(draft)}
            sx={{ minHeight: 34, px: 1.75 }}
          >
            {saveMutation.isPending
              ? t("settingsPage.agentAccess.saving")
              : t("settingsPage.agentAccess.save")}
          </Button>
        </SettingsFooter>
      </SectionCard>

      {feedback ? (
        <Alert severity={feedback.severity} variant="outlined" sx={compactAlertSx}>
          {feedback.message}
        </Alert>
      ) : null}

      <Box>
        <Typography variant="h6" sx={{ fontSize: 17, mb: 0.25 }}>
          {t("settingsPage.agentAccess.clientsTitle")}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
          {t("settingsPage.agentAccess.clientsDescription")}
        </Typography>
        <Box
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: { lg: "repeat(3, minmax(0, 1fr))", xs: "1fr" },
          }}
        >
          {settings.clients.map((info) => (
            <AgentClientConfigCard
              key={info.client}
              info={info}
              busy={busy}
              installStatus={installStatus[info.client]}
              onCopy={(client) => void copyConfig(client)}
              onInstallConfig={(client) => void beginConfigInstall(client)}
              onInstall={(client) => installMutation.mutate({ info: client, overwrite: false })}
            />
          ))}
        </Box>
      </Box>

      <AgentAuditTable
        data={auditQuery.data}
        loading={auditQuery.isFetching}
        onRefresh={() => void auditQuery.refetch()}
      />

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
        isConfirming={installConfigMutation.isPending}
        onCancel={() => setPendingConfigInstall(null)}
        onConfirm={() => {
          if (pendingConfigInstall) {
            const input = {
              client: pendingConfigInstall.info.client,
              ...(pendingConfigInstall.projectDir
                ? { projectDir: pendingConfigInstall.projectDir }
                : {}),
            };
            installConfigMutation.mutate(input);
          }
        }}
      />

      <ConfirmDialog
        open={pendingInstall !== null}
        title={t("settingsPage.agentAccess.overwriteTitle")}
        message={t("settingsPage.agentAccess.overwriteMessage", {
          path: pendingInstall?.skillPath ?? "",
        })}
        confirmColor="warning"
        confirmLabel={t("settingsPage.agentAccess.overwriteConfirm")}
        isConfirming={installMutation.isPending}
        onCancel={() => setPendingInstall(null)}
        onConfirm={() => {
          if (pendingInstall) {
            installMutation.mutate({ info: pendingInstall, overwrite: true });
          }
        }}
      />
    </Stack>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
        {value}
      </Typography>
    </Box>
  );
}

function draftFromSettings(settings: AgentAccessSettings): AgentAccessDraft {
  return {
    enabled: settings.enabled,
    permissions: { ...settings.permissions },
    limits: { ...settings.limits },
  };
}
