import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
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
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  coerceAppError,
  type AgentAccessLimits,
  type AgentAccessPermissions,
  type AgentAccessRedaction,
  type AgentAccessSettings,
  type AgentAccessTestResult,
  type AgentCapability,
  type AgentClientInfo,
  type AgentGrant,
  type InstallAgentClientConfigResult,
  type InstallAgentSkillResult,
  type RevokeAgentControlResult,
  type UpdateAgentAccessSettingsInput,
} from "@aiproxy/shared-types";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { SectionCard } from "@/components/shared/SectionCard";
import { AgentAuditTable } from "@/features/agent-access/AgentAuditTable";
import { AgentCapabilityModeSelect } from "@/features/agent-access/AgentCapabilityModeSelect";
import { AgentConnectDialog } from "@/features/agent-access/AgentConnectDialog";
import {
  AgentClientRow,
  type AgentClientPendingAction,
} from "@/features/agent-access/AgentClientRow";
import { AgentPathValue } from "@/features/agent-access/AgentPathValue";
import { AgentGrantList } from "@/features/agent-access/AgentGrantList";
import {
  AGENT_AUDIT_QUERY_KEY,
  AGENT_GRANTS_QUERY_KEY,
  AGENT_SETTINGS_QUERY_KEY,
} from "@/features/agent-access/agent-access-query-keys";
import {
  AGENT_PERMISSION_PRESETS,
  accessForConnectPreset,
  accessForPreset,
  grantRequestPoliciesEqual,
  permissionsEqual,
  permissionsForPreset,
  presetDescriptionKey,
  presetLabelKey,
  presetForPermissions,
  shouldConfirmConfigWrite,
  type AgentConnectPreset,
  type AgentPresetSelection,
} from "@/features/agent-access/agent-access.helpers";
import {
  applyCapabilityMode,
  capabilityModeLabelKey,
  capabilityMode,
  requiresAccessChangeConfirmation,
  type AgentCapabilityMode,
} from "@/features/agent-access/agent-access.grant-policy";
import {
  AGENT_PERMISSION_GROUPS,
  AGENT_PERMISSION_KEYS,
  availablePermissionDefinitions,
  countEnabledPermissions,
  enabledPermissionDefinitions,
  hasUnmetPermissionDependencies,
  isAgentAdvancedPermissionTarget,
  isAgentPermissionMatrixTarget,
  permissionDefinition,
  permissionRiskKey,
  type AgentPermissionGroupId,
  type AgentPermissionRisk,
} from "@/features/agent-access/agent-access.permissions";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { useI18n, type TranslationKey } from "@/i18n";
import {
  getAgentAccessSettings,
  getAgentAuditLog,
  listAgentAccessGrants,
  installAgentClientConfig,
  installAgentSkill,
  pickAutomationApprovedRoot,
  removeAgentClientConfig,
  revokeAgentAccessGrant,
  revokeAgentControlPermissions,
  testAgentAccess,
  updateAgentAccessSettings,
  disableSystemProxy,
  stopProxy,
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

type AgentAccessDraft = UpdateAgentAccessSettingsInput;
type FeedbackArea = "client" | "diagnostics" | "permissions" | "settings";
type PermissionDraftSnapshot = Pick<AgentAccessDraft, "permissions" | "grantRequestPolicy">;

type SaveInput = {
  area: Extract<FeedbackArea, "permissions" | "settings">;
  draft: AgentAccessDraft;
};

type Feedback = {
  area: FeedbackArea;
  severity: "error" | "info" | "success" | "warning";
  message: string;
};

type PendingConfigWrite = {
  info: AgentClientInfo;
};

type AgentAccessChangeItem = {
  id: string;
  label: string;
  before: string;
  after: string;
  highRisk: boolean;
  risk?: AgentPermissionRisk;
  kind: "enabled" | "permission" | "policy" | "scope";
};

type PendingConnect = {
  info: AgentClientInfo;
  preset: AgentConnectPreset;
};

type ConnectInput = PendingConnect;

type ConnectResult = {
  outcome: ConnectOutcome;
  settings: AgentAccessSettings | null;
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

export function AgentAccessSection({
  highlightedItemId = null,
}: {
  highlightedItemId?: string | null;
} = {}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AgentAccessDraft | null>(null);
  const [customAccess, setCustomAccess] = useState<PermissionDraftSnapshot | null>(null);
  const [presetSelection, setPresetSelection] = useState<AgentPresetSelection>("readOnly");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingSkillOverwrite, setPendingSkillOverwrite] = useState<PendingSkillOverwrite | null>(
    null,
  );
  const [pendingConfigInstall, setPendingConfigInstall] = useState<PendingConfigWrite | null>(null);
  const [pendingConnect, setPendingConnect] = useState<PendingConnect | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<AgentClientInfo | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pickingAutomationRoot, setPickingAutomationRoot] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [pendingHighRiskSave, setPendingHighRiskSave] = useState<SaveInput | null>(null);
  const [pendingHighRiskConnect, setPendingHighRiskConnect] = useState<{
    input: ConnectInput;
    items: AgentAccessChangeItem[];
  } | null>(null);
  const [bulkGrantOpen, setBulkGrantOpen] = useState(false);
  const [revokeControlOpen, setRevokeControlOpen] = useState(false);
  const [revokeResult, setRevokeResult] = useState<RevokeAgentControlResult | null>(null);
  const [pendingRevokeGrant, setPendingRevokeGrant] = useState<AgentGrant | null>(null);

  const settingsQuery = useQuery({
    queryKey: AGENT_SETTINGS_QUERY_KEY,
    queryFn: getAgentAccessSettings,
  });
  const auditQuery = useQuery({
    queryKey: AGENT_AUDIT_QUERY_KEY,
    queryFn: () => getAgentAuditLog(50),
  });
  const grantsQuery = useQuery({
    queryKey: AGENT_GRANTS_QUERY_KEY,
    queryFn: listAgentAccessGrants,
    refetchInterval: 5_000,
  });
  const savedDraftCandidate = settingsQuery.data ? draftFromSettings(settingsQuery.data) : null;
  const agentSettingsReady = Boolean(settingsQuery.data && draft);
  const dirty =
    draft !== null && savedDraftCandidate !== null && !draftsEqual(draft, savedDraftCandidate);
  const unsavedGuard = useUnsavedChangesGuard(dirty);

  useEffect(() => {
    if (settingsQuery.data && !draft) {
      replaceDraftFromSettings(settingsQuery.data);
    }
  }, [draft, settingsQuery.data]);

  useEffect(() => {
    if (!draft || presetSelection !== "custom") return;
    const next = draftAccessSnapshot(draft);
    setCustomAccess((current) =>
      current && permissionDraftSnapshotsEqual(current, next) ? current : next,
    );
  }, [draft, presetSelection]);

  useEffect(() => {
    if (!highlightedItemId || !isAgentPermissionMatrixTarget(highlightedItemId)) return;
    setPermissionsOpen(true);
    if (isAgentAdvancedPermissionTarget(highlightedItemId)) setAdvancedOpen(true);
    if (!agentSettingsReady) return;

    const timer = window.setTimeout(() => {
      document
        .getElementById(`settings-item-${highlightedItemId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [agentSettingsReady, highlightedItemId]);

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

  function replaceDraftFromSettings(settings: AgentAccessSettings) {
    const nextDraft = draftFromSettings(settings);
    const nextPreset = presetForPermissions(nextDraft.permissions, nextDraft.grantRequestPolicy);
    setDraft(nextDraft);
    setPresetSelection(nextPreset);
    setCustomAccess((current) =>
      nextPreset === "custom" ? draftAccessSnapshot(nextDraft) : current,
    );
  }

  function applyConfigResult(result: InstallAgentClientConfigResult) {
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
      skillVersion: info.bundledSkillVersion,
    }));
  }

  const saveMutation = useMutation({
    mutationFn: (input: SaveInput) => updateAgentAccessSettings(input.draft),
    onSuccess: (settings, input) => {
      queryClient.setQueryData(AGENT_SETTINGS_QUERY_KEY, settings);
      replaceDraftFromSettings(settings);
      setPendingHighRiskSave(null);
      setFeedback({
        area: input.area,
        severity: "success",
        message: t("settingsPage.agentAccess.saveSuccess"),
      });
    },
    onError: (error, input) => {
      setPendingHighRiskSave(null);
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
      if (result.ok) {
        setFeedback(null);
      }
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

  const removeMutation = useMutation({
    mutationFn: (info: AgentClientInfo) =>
      removeAgentClientConfig({ client: info.client, removeSkill: true }),
    onSuccess: (result, info) => {
      setPendingRemove(null);
      updateClientCache(info.client, (current) => ({
        ...current,
        configInstalled: false,
        skillInstalled: false,
        skillManaged: result.skillRemoved ? false : current.skillManaged,
        skillVersion: result.skillRemoved ? null : (current.skillVersion ?? null),
      }));
      const label = clientName(info.client, t);
      if (result.status === "notInstalled") {
        setFeedback({
          area: "client",
          severity: "info",
          message: t("settingsPage.agentAccess.disconnectNotInstalled", { client: label }),
        });
        return;
      }
      const message = t("settingsPage.agentAccess.disconnectSuccess", {
        client: label,
        path: result.path,
      });
      if (result.skillError) {
        setFeedback({
          area: "client",
          severity: "warning",
          message: t("settingsPage.agentAccess.disconnectSkillFailed", {
            message,
            error: result.skillError,
          }),
        });
        return;
      }
      if (result.skillSkipped) {
        setFeedback({
          area: "client",
          severity: "warning",
          message: t("settingsPage.agentAccess.disconnectSkillSkipped", {
            message,
            path: info.skillPath,
          }),
        });
        return;
      }
      setFeedback({
        area: "client",
        severity: "success",
        message: result.backupPath
          ? `${message} ${t("settingsPage.agentAccess.configBackup", { path: result.backupPath })}`
          : message,
      });
    },
    onError: (error) => {
      setPendingRemove(null);
      setFeedback({
        area: "client",
        severity: "error",
        message: coerceAppError(error).message || t("settingsPage.agentAccess.disconnectFailed"),
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const revokeGrantMutation = useMutation({
    mutationFn: (grant: AgentGrant) => revokeAgentAccessGrant({ grantId: grant.id }),
    onSuccess: () => {
      setPendingRevokeGrant(null);
      void queryClient.invalidateQueries({ queryKey: AGENT_GRANTS_QUERY_KEY });
    },
    onError: (error) => {
      setPendingRevokeGrant(null);
      setFeedback({
        area: "permissions",
        severity: "error",
        message: coerceAppError(error).message,
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const revokeControlMutation = useMutation({
    mutationFn: async () => {
      const result = await revokeAgentControlPermissions();
      const settings = await getAgentAccessSettings();
      return { result, settings };
    },
    onSuccess: ({ result, settings }) => {
      setRevokeControlOpen(false);
      setRevokeResult(result);
      setPendingHighRiskSave(null);
      queryClient.setQueryData(AGENT_SETTINGS_QUERY_KEY, settings);
      replaceDraftFromSettings(settings);
      void queryClient.invalidateQueries({ queryKey: AGENT_GRANTS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: AGENT_AUDIT_QUERY_KEY });
      setFeedback({
        area: "permissions",
        severity: "success",
        message: t("settingsPage.agentAccess.revokeResultTitle"),
      });
    },
    onError: (error) => {
      setFeedback({
        area: "permissions",
        severity: "error",
        message: coerceAppError(error).message,
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const residualCleanupMutation = useMutation({
    mutationFn: async (kind: "stopCapture" | "restoreProxy") => {
      if (kind === "restoreProxy") {
        await disableSystemProxy();
        return kind;
      }
      await stopProxy({
        workspaceId: revokeResult?.activeEffects.workspaceId ?? "default",
      });
      return kind;
    },
    onSuccess: (kind) => {
      setRevokeResult((current) =>
        current
          ? {
              ...current,
              activeEffects: {
                ...current.activeEffects,
                ...(kind === "restoreProxy"
                  ? { systemProxyEnabled: false }
                  : { captureRunning: false }),
              },
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: AGENT_SETTINGS_QUERY_KEY });
    },
    onError: (error) => {
      setFeedback({
        area: "permissions",
        severity: "error",
        message: coerceAppError(error).message,
      });
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const connectMutation = useMutation({
    mutationFn: async (input: ConnectInput): Promise<ConnectResult> => {
      if (!draft) throw new Error(t("common.errors.generic"));
      const access = accessForConnectPreset(input.preset, {
        permissions: draft.permissions,
        grantRequestPolicy: draft.grantRequestPolicy,
      });
      let settings: AgentAccessSettings | null = null;
      if (
        !permissionsEqual(draft.permissions, access.permissions) ||
        !grantRequestPoliciesEqual(draft.grantRequestPolicy, access.grantRequestPolicy)
      ) {
        try {
          settings = await updateAgentAccessSettings({
            enabled: draft.enabled,
            permissions: access.permissions,
            limits: draft.limits,
            redaction: draft.redaction,
            automationApprovedRoots: draft.automationApprovedRoots,
            proxiedVerificationOrigins: draft.proxiedVerificationOrigins,
            automationCrossHostOrigins: draft.automationCrossHostOrigins,
            grantRequestPolicy: access.grantRequestPolicy,
          });
        } catch (error) {
          throw new Error(coerceAppError(error).message || t("common.errors.generic"), {
            cause: error,
          });
        }
      }

      let config: InstallAgentClientConfigResult;
      try {
        config = await installAgentClientConfig({ client: input.info.client });
      } catch (error) {
        return {
          settings,
          outcome: {
            kind: "configFailed",
            message:
              coerceAppError(error).message || t("settingsPage.agentAccess.configInstallFailed"),
          },
        };
      }

      try {
        const skill = await installAgentSkill({
          client: input.info.client,
          overwrite: false,
        });
        if (skill.status === "overwriteRequired") {
          return { settings, outcome: { config, kind: "skillOverwriteRequired" } };
        }
        return { settings, outcome: { config, kind: "success", skill } };
      } catch (error) {
        return {
          settings,
          outcome: {
            config,
            kind: "skillFailed",
            message: coerceAppError(error).message || t("common.errors.generic"),
          },
        };
      }
    },
    onSuccess: (result, input) => {
      setPendingConnect(null);
      setConnectError(null);
      if (result.settings) {
        queryClient.setQueryData(AGENT_SETTINGS_QUERY_KEY, result.settings);
        replaceDraftFromSettings(result.settings);
      }

      const outcome = result.outcome;
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
      setDiagnosticsOpen(true);
      setFeedback({
        area: "client",
        severity: "success",
        message: connectSuccessMessage(outcome, input.info, t),
      });
    },
    onError: (error) => {
      setConnectError(
        coerceAppError(error).message || t("settingsPage.agentAccess.configInstallFailed"),
      );
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
  const savedDraft = draftFromSettings(settings);
  const connectedClientCount = settings.clients.filter((client) => client.configInstalled).length;
  const bodyDisabled = !settings.permissions.readBodies;
  const rawBodiesBlocked = hasUnmetPermissionDependencies(draft.permissions, "readRawBodies");
  const allGrants = grantsQuery.data?.grants ?? [];
  const activeGrantStatuses = new Set(["pending", "approved", "executing"]);
  const visibleGrants = [
    ...allGrants.filter((grant) => activeGrantStatuses.has(grant.status)),
    ...allGrants
      .filter((grant) => !activeGrantStatuses.has(grant.status))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 10),
  ];
  const changeItems = buildAgentAccessChangeItems(savedDraft, draft, t);
  const highRiskChangeItems = changeItems.filter((item) => item.highRisk);
  const busy =
    saveMutation.isPending ||
    testMutation.isPending ||
    connectMutation.isPending ||
    configMutation.isPending ||
    skillMutation.isPending ||
    removeMutation.isPending;
  const activeClient = activeMutationClient(
    connectMutation,
    configMutation,
    skillMutation,
    removeMutation,
  );
  const activeAction = activeMutationAction(
    connectMutation,
    configMutation,
    skillMutation,
    removeMutation,
  );

  function updateCapabilityMode(key: keyof AgentAccessPermissions, mode: AgentCapabilityMode) {
    setPresetSelection("custom");
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        ...applyCapabilityMode(current.permissions, current.grantRequestPolicy, key, mode),
      };
    });
  }

  function applyPreset(preset: (typeof AGENT_PERMISSION_PRESETS)[number]) {
    if (draft && presetSelection === "custom") {
      setCustomAccess(draftAccessSnapshot(draft));
    }
    setDraft((current) =>
      current
        ? {
            ...current,
            ...accessForPreset(preset),
          }
        : current,
    );
    setPresetSelection(preset);
  }

  function applyCustomPreset() {
    const access = customAccess ?? accessForPreset("readOnly");
    setDraft((current) =>
      current
        ? {
            ...current,
            permissions: { ...access.permissions },
            grantRequestPolicy: { ...access.grantRequestPolicy },
          }
        : current,
    );
    setPresetSelection("custom");
  }

  function enableAllAvailablePermissions() {
    setDraft((current) => {
      if (!current) return current;
      let permissions = { ...current.permissions };
      let grantRequestPolicy = { ...current.grantRequestPolicy };
      for (const definition of availablePermissionDefinitions()) {
        const next = applyCapabilityMode(permissions, grantRequestPolicy, definition.key, "always");
        permissions = next.permissions;
        grantRequestPolicy = next.grantRequestPolicy;
      }
      return { ...current, permissions, grantRequestPolicy };
    });
    setPresetSelection("custom");
    setBulkGrantOpen(false);
    setPermissionsOpen(true);
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

  async function addAutomationRoot() {
    if (!draft || pickingAutomationRoot || draft.automationApprovedRoots.length >= 10) return;
    setPickingAutomationRoot(true);
    try {
      const path = await pickAutomationApprovedRoot(
        t("settingsPage.agentAccess.automationRootPickerTitle"),
      );
      if (!path) return;
      setDraft((current) => {
        if (!current || current.automationApprovedRoots.includes(path)) return current;
        return {
          ...current,
          automationApprovedRoots: [...current.automationApprovedRoots, path].slice(0, 10),
        };
      });
    } catch (error) {
      setFeedback({
        area: "permissions",
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    } finally {
      setPickingAutomationRoot(false);
    }
  }

  function removeAutomationRoot(path: string) {
    setDraft((current) =>
      current
        ? {
            ...current,
            automationApprovedRoots: current.automationApprovedRoots.filter(
              (root) => root !== path,
            ),
          }
        : current,
    );
  }

  function addOrigin(
    field: "proxiedVerificationOrigins" | "automationCrossHostOrigins",
    origin: string,
  ) {
    setDraft((current) => {
      if (!current || current[field].includes(origin)) return current;
      return { ...current, [field]: [...current[field], origin].sort() };
    });
  }

  function removeOrigin(
    field: "proxiedVerificationOrigins" | "automationCrossHostOrigins",
    origin: string,
  ) {
    setDraft((current) =>
      current
        ? { ...current, [field]: current[field].filter((value) => value !== origin) }
        : current,
    );
  }

  function discardDraft() {
    replaceDraftFromSettings(settings);
  }

  function saveDraft(area: SaveInput["area"]) {
    if (!draft || !dirty || busy) return;
    if (
      requiresAccessChangeConfirmation(
        savedDraft.permissions,
        savedDraft.grantRequestPolicy,
        draft.permissions,
        draft.grantRequestPolicy,
      )
    ) {
      setPendingHighRiskSave({ area, draft });
      return;
    }
    saveMutation.mutate({ area, draft });
  }

  function startConnect(input: ConnectInput) {
    if (!draft) return;
    const access = accessForConnectPreset(input.preset, {
      permissions: draft.permissions,
      grantRequestPolicy: draft.grantRequestPolicy,
    });
    const highRiskItems = buildAgentAccessChangeItems(
      savedDraft,
      { ...draft, ...access },
      t,
    ).filter((item) => item.highRisk);
    if (highRiskItems.length > 0) {
      setPendingConnect(null);
      setPendingHighRiskConnect({ input, items: highRiskItems });
      return;
    }
    connectMutation.mutate(input);
  }

  function openPermissionDetails() {
    setPermissionsOpen(true);
    window.requestAnimationFrame(() => {
      document
        .getElementById("settings-item-agent-permissions")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function copyText(value: string, area: FeedbackArea = "client") {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({
        area,
        severity: "success",
        message: t("settingsPage.agentAccess.copiedToClipboard"),
      });
    } catch (error) {
      setFeedback({
        area,
        severity: "error",
        message: coerceAppError(error).message || t("settingsPage.agentAccess.copyFailed"),
      });
    }
  }

  function openConnectDialog(info: AgentClientInfo) {
    if (!draft) return;
    setConnectError(null);
    setPendingConnect({
      info,
      preset: presetForPermissions(draft.permissions, draft.grantRequestPolicy),
    });
  }

  function beginConfigWrite(info: AgentClientInfo) {
    if (shouldConfirmConfigWrite(info)) {
      setPendingConfigInstall({ info });
    } else {
      configMutation.mutate({ client: info.client });
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

            <CapabilitySummary
              dirty={dirty}
              enabled={settings.enabled}
              onAdjust={openPermissionDetails}
              onRevokeControl={() => setRevokeControlOpen(true)}
              permissions={settings.permissions}
              grantRequestPolicy={settings.grantRequestPolicy}
              revokeBusy={revokeControlMutation.isPending}
            />

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
                    <Button
                      color="inherit"
                      size="small"
                      disabled={busy}
                      onClick={() => setChangesOpen(true)}
                    >
                      {t("settingsPage.agentAccess.viewChanges")}
                    </Button>
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
                <Stack spacing={0.25}>
                  <Typography variant="body2">
                    {t("settingsPage.agentAccess.unsavedChangesHint")}
                  </Typography>
                  <Typography variant="caption">
                    {t("settingsPage.agentAccess.pendingChangeCount", {
                      count: changeItems.length,
                    })}
                    {highRiskChangeItems.length > 0
                      ? ` · ${t("settingsPage.agentAccess.highRiskChangeSummary", {
                          count: highRiskChangeItems.length,
                        })}`
                      : null}
                  </Typography>
                </Stack>
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
                    onCopy={(value) => void copyText(value, "diagnostics")}
                    value={settings.sidecarPath ?? "-"}
                  />
                  <AgentPathValue
                    copyLabel={t("settingsPage.agentAccess.copyPath")}
                    label={t("settingsPage.agentAccess.dataDirLabel")}
                    onCopy={(value) => void copyText(value, "diagnostics")}
                    value={settings.dataDir}
                  />
                  <AgentPathValue
                    copyLabel={t("settingsPage.agentAccess.copyPath")}
                    label={t("settingsPage.agentAccess.configPathLabel")}
                    onCopy={(value) => void copyText(value, "diagnostics")}
                    value={settings.configPath}
                  />
                  <AgentPathValue
                    copyLabel={t("settingsPage.agentAccess.copyPath")}
                    label={t("settingsPage.agentAccess.auditPathLabel")}
                    onCopy={(value) => void copyText(value, "diagnostics")}
                    value={settings.auditPath}
                  />
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {t("settingsPage.agentAccess.diagnosticsHint")}
                  </Typography>
                  {feedback?.area === "diagnostics" ? <FeedbackAlert feedback={feedback} /> : null}
                  <Box>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<PlayArrowRoundedIcon />}
                      disabled={busy}
                      onClick={() => testMutation.mutate()}
                      sx={{ minHeight: 34 }}
                    >
                      {testMutation.isPending
                        ? t("settingsPage.agentAccess.testing")
                        : t("settingsPage.agentAccess.test")}
                    </Button>
                  </Box>
                  {testMutation.data ? (
                    <AgentCheckList
                      result={testMutation.data}
                      onCopy={() =>
                        void copyText(JSON.stringify(testMutation.data, null, 2), "diagnostics")
                      }
                    />
                  ) : null}
                </Stack>
              </Collapse>
            </Box>
          </Stack>
        </SectionCard>
      </Box>

      {revokeResult ? (
        <RevokeResultCard
          result={revokeResult}
          cleanupPending={residualCleanupMutation.isPending}
          onClose={() => setRevokeResult(null)}
          onManageCertificates={() => navigate("/certificates")}
          onRestoreProxy={() => residualCleanupMutation.mutate("restoreProxy")}
          onStopCapture={() => residualCleanupMutation.mutate("stopCapture")}
          onViewRules={() => navigate("/rules")}
        />
      ) : null}

      {visibleGrants.length > 0 ? (
        <SectionCard
          compact
          title={t("settingsPage.agentAccess.grantsTitle")}
          description={t("settingsPage.agentAccess.grantsDescription")}
          toolbar={
            <Button
              size="small"
              variant="outlined"
              disabled={revokeGrantMutation.isPending || grantsQuery.isFetching}
              onClick={() => void grantsQuery.refetch()}
            >
              {grantsQuery.isFetching
                ? t("settingsPage.agentAccess.grantsRefreshing")
                : t("settingsPage.agentAccess.grantsRefresh")}
            </Button>
          }
        >
          <AgentGrantList
            busy={revokeGrantMutation.isPending}
            data={grantsQuery.data}
            loading={grantsQuery.isFetching}
            onRefresh={() => void grantsQuery.refetch()}
            onRevoke={setPendingRevokeGrant}
            showHeader={false}
          />
        </SectionCard>
      ) : null}

      <SectionCard
        compact
        title={t("settingsPage.agentAccess.clientsTitle")}
        description={t("settingsPage.agentAccess.clientsDescription")}
      >
        <Alert severity="info" variant="outlined" sx={{ ...compactAlertSx, mb: 1.5 }}>
          {t("settingsPage.agentAccess.dataFlowNote")}
        </Alert>
        {connectedClientCount > 0 && bodyDisabled ? (
          <Alert severity="warning" variant="outlined" sx={{ ...compactAlertSx, mb: 1.5 }}>
            {t("settingsPage.agentAccess.bodyDisabledAfterConnect")}
          </Alert>
        ) : null}
        <Stack divider={<Divider flexItem />} spacing={0}>
          {settings.clients.map((info) => (
            <AgentClientRow
              key={info.client}
              busy={busy}
              info={info}
              itemId={info.client === "cursor" ? "agent-cursor" : undefined}
              pendingAction={activeClient === info.client ? activeAction : null}
              onConnect={(client) => openConnectDialog(client)}
              onCopyText={(value) => void copyText(value)}
              onInstallSkill={(client) =>
                skillMutation.mutate({ info: client, origin: "skill", overwrite: false })
              }
              onRemove={(client) => setPendingRemove(client)}
              onWriteConfig={(client) => beginConfigWrite(client)}
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
          allowStickyFooter
          compact
          title={t("settingsPage.agentAccess.permissionsTitle")}
          description={t("settingsPage.agentAccess.permissionsDescription")}
        >
          <Box sx={{ pb: 2 }}>
            <SettingsRow
              label={t("settingsPage.agentAccess.presetTitle")}
              description={t("settingsPage.agentAccess.presetDescription")}
              hint={
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    color: "text.secondary",
                    lineHeight: 1.5,
                    mt: 0.5,
                  }}
                >
                  {t(presetDescriptionKey(presetSelection))}
                </Typography>
              }
            >
              <TextField
                select
                size="small"
                value={presetSelection}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value as AgentPresetSelection;
                  if (value === "custom") {
                    applyCustomPreset();
                    return;
                  }
                  applyPreset(value);
                }}
                slotProps={{
                  select: {
                    inputProps: { "aria-label": t("settingsPage.agentAccess.presetTitle") },
                  },
                }}
                sx={selectControlSx}
              >
                {AGENT_PERMISSION_PRESETS.map((preset) => (
                  <MenuItem key={preset} value={preset}>
                    {t(presetLabelKey(preset))}
                  </MenuItem>
                ))}
                <MenuItem value="custom">{t("settingsPage.agentAccess.presetCustom")}</MenuItem>
              </TextField>
            </SettingsRow>
            <Alert severity="info" variant="outlined" sx={{ ...compactAlertSx, mt: 1.5 }}>
              {t("settingsPage.agentAccess.capabilityModeDescription")}
            </Alert>
          </Box>
          <Stack
            direction={{ sm: "row", xs: "column" }}
            spacing={1}
            sx={{
              alignItems: { sm: "center", xs: "stretch" },
              justifyContent: "space-between",
              pb: 1.5,
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {t("settingsPage.agentAccess.permissionMatrixTitle")}
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {t("settingsPage.agentAccess.permissionMatrixDescription")}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
              <Button
                size="small"
                color="warning"
                variant="outlined"
                disabled={busy}
                onClick={() => setBulkGrantOpen(true)}
              >
                {t("settingsPage.agentAccess.bulkGrantAction")}
              </Button>
              <Button
                size="small"
                variant="outlined"
                aria-expanded={permissionsOpen ? "true" : "false"}
                aria-controls="agent-permission-groups"
                onClick={() => setPermissionsOpen((current) => !current)}
                endIcon={
                  <ExpandMoreRoundedIcon
                    fontSize="small"
                    sx={{
                      transform: permissionsOpen ? "rotate(180deg)" : "none",
                      transition: "transform 150ms ease",
                    }}
                  />
                }
              >
                {permissionsOpen
                  ? t("settingsPage.agentAccess.permissionMatrixHide")
                  : t("settingsPage.agentAccess.permissionMatrixShow")}
              </Button>
            </Stack>
          </Stack>
          <Collapse id="agent-permission-groups" in={permissionsOpen} unmountOnExit>
            <Box>
              <PermissionGroupHeading group="readData" permissions={draft.permissions} />
              <SettingsGroup>
                <SettingsRow
                  itemId="agent-read-sessions"
                  label={t("settingsPage.agentAccess.readSessionsLabel")}
                  description={t("settingsPage.agentAccess.readSessionsDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="readSessions"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "readSessions",
                    )}
                    onChange={(mode) => updateCapabilityMode("readSessions", mode)}
                  />
                </SettingsRow>
                <SettingsRow
                  itemId="agent-read-bodies"
                  label={t("settingsPage.agentAccess.readBodiesLabel")}
                  description={t("settingsPage.agentAccess.readBodiesDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="readBodies"
                    mode={capabilityMode(draft.permissions, draft.grantRequestPolicy, "readBodies")}
                    onChange={(mode) => updateCapabilityMode("readBodies", mode)}
                  />
                </SettingsRow>
                <SettingsRow
                  itemId="agent-read-websocket"
                  label={t("settingsPage.agentAccess.readWebSocketLabel")}
                  description={t("settingsPage.agentAccess.readWebSocketDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="readWebSocket"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "readWebSocket",
                    )}
                    onChange={(mode) => updateCapabilityMode("readWebSocket", mode)}
                  />
                </SettingsRow>
              </SettingsGroup>

              <Divider sx={{ mt: 1 }} />
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: "center", justifyContent: "space-between", pt: 1.5 }}
              >
                <Box>
                  <Typography variant="subtitle2">
                    {t("settingsPage.agentAccess.controlPermissionsTitle")}
                  </Typography>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {t("settingsPage.agentAccess.controlPermissionsDescription")}
                  </Typography>
                </Box>
              </Stack>
              <PermissionGroupHeading group="controlDesktop" permissions={draft.permissions} />
              <SettingsGroup>
                <SettingsRow
                  itemId="agent-control-capture"
                  label={t("settingsPage.agentAccess.controlCaptureLabel")}
                  description={t("settingsPage.agentAccess.controlCaptureDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="controlCapture"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "controlCapture",
                    )}
                    onChange={(mode) => updateCapabilityMode("controlCapture", mode)}
                  />
                </SettingsRow>
                <SettingsRow
                  itemId="agent-control-system-proxy"
                  label={t("settingsPage.agentAccess.controlSystemProxyLabel")}
                  description={t("settingsPage.agentAccess.controlSystemProxyDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="controlSystemProxy"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "controlSystemProxy",
                    )}
                    onChange={(mode) => updateCapabilityMode("controlSystemProxy", mode)}
                  />
                </SettingsRow>
                <SettingsRow
                  itemId="agent-control-certificates"
                  label={t("settingsPage.agentAccess.manageCertificatesLabel")}
                  description={t("settingsPage.agentAccess.manageCertificatesDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="manageCertificates"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "manageCertificates",
                    )}
                    onChange={(mode) => updateCapabilityMode("manageCertificates", mode)}
                  />
                </SettingsRow>
                <PermissionGroupHeading
                  group="dangerous"
                  permissions={draft.permissions}
                  insideGroup
                />
                <SettingsRow
                  itemId="agent-control-delete-sessions"
                  label={t("settingsPage.agentAccess.deleteSessionsLabel")}
                  description={t("settingsPage.agentAccess.deleteSessionsDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="deleteSessions"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "deleteSessions",
                    )}
                    onChange={(mode) => updateCapabilityMode("deleteSessions", mode)}
                  />
                </SettingsRow>
                <PermissionGroupHeading
                  group="modifyRequests"
                  permissions={draft.permissions}
                  insideGroup
                />
                <SettingsRow
                  itemId="agent-send-requests"
                  label={t("settingsPage.agentAccess.sendRequestsLabel")}
                  description={t("settingsPage.agentAccess.sendRequestsDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="sendRequests"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "sendRequests",
                    )}
                    onChange={(mode) => updateCapabilityMode("sendRequests", mode)}
                  />
                </SettingsRow>
                <SettingsRow
                  itemId="agent-manage-rules"
                  label={t("settingsPage.agentAccess.manageRulesLabel")}
                  description={t("settingsPage.agentAccess.manageRulesDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="manageRules"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "manageRules",
                    )}
                    onChange={(mode) => updateCapabilityMode("manageRules", mode)}
                  />
                </SettingsRow>
                <SettingsRow
                  itemId="agent-manage-proxied-verification"
                  label={t("settingsPage.agentAccess.manageProxiedVerificationLabel")}
                  description={t("settingsPage.agentAccess.manageProxiedVerificationDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="manageProxiedVerification"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "manageProxiedVerification",
                    )}
                    onChange={(mode) => updateCapabilityMode("manageProxiedVerification", mode)}
                  />
                </SettingsRow>
                <PermissionGroupHeading
                  group="agentAutomation"
                  permissions={draft.permissions}
                  insideGroup
                />
                <SettingsRow
                  itemId="agent-manage-automation"
                  label={t("settingsPage.agentAccess.manageAutomationLabel")}
                  description={t("settingsPage.agentAccess.manageAutomationDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="manageAutomation"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "manageAutomation",
                    )}
                    onChange={(mode) => updateCapabilityMode("manageAutomation", mode)}
                  />
                </SettingsRow>
                <SettingsRow
                  itemId="agent-manage-user-automation"
                  label={t("settingsPage.agentAccess.manageUserAutomationLabel")}
                  description={t("settingsPage.agentAccess.manageUserAutomationDescription")}
                >
                  <AgentCapabilityModeSelect
                    capability="manageUserAutomation"
                    mode={capabilityMode(
                      draft.permissions,
                      draft.grantRequestPolicy,
                      "manageUserAutomation",
                    )}
                    onChange={(mode) => updateCapabilityMode("manageUserAutomation", mode)}
                  />
                </SettingsRow>
              </SettingsGroup>
              {draft.permissions.manageAutomation || draft.permissions.manageProxiedVerification ? (
                <>
                  <Divider sx={{ mt: 2 }} />
                  <Box sx={{ pt: 1.5 }}>
                    <Typography variant="subtitle2">
                      {t("settingsPage.agentAccess.automationScopeTitle")}
                    </Typography>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      {t("settingsPage.agentAccess.automationScopeDescription")}
                    </Typography>
                  </Box>
                  <Alert severity="info" variant="outlined" sx={{ ...compactAlertSx, mt: 1 }}>
                    {t("settingsPage.agentAccess.newAutomationPermissionsHint")}
                  </Alert>

                  {draft.permissions.manageAutomation ? (
                    <Box sx={{ mt: 1.5 }}>
                      <Typography variant="subtitle2">
                        {t("settingsPage.agentAccess.automationRootsTitle")}
                      </Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {t("settingsPage.agentAccess.automationRootsDescription")}
                      </Typography>
                      <Stack
                        direction="row"
                        spacing={1}
                        useFlexGap
                        sx={{ flexWrap: "wrap", mt: 1 }}
                      >
                        {draft.automationApprovedRoots.map((path) => {
                          const status = settings.automationApprovedRootStatuses.find(
                            (entry) => entry.path === path,
                          );
                          const invalid = status ? !status.exists || !status.isDirectory : false;
                          return (
                            <Chip
                              key={path}
                              color={invalid ? "warning" : "default"}
                              icon={invalid ? <WarningAmberRoundedIcon /> : undefined}
                              label={path}
                              onDelete={() => removeAutomationRoot(path)}
                              deleteIcon={<DeleteOutlineRoundedIcon />}
                              sx={{ maxWidth: "100%" }}
                            />
                          );
                        })}
                      </Stack>
                      {draft.automationApprovedRoots.length === 0 ? (
                        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
                          {t("settingsPage.agentAccess.automationRootsEmpty")}
                        </Typography>
                      ) : null}
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => void addAutomationRoot()}
                        disabled={
                          busy ||
                          pickingAutomationRoot ||
                          draft.automationApprovedRoots.length >= 10
                        }
                        sx={{ mt: 1 }}
                      >
                        {pickingAutomationRoot
                          ? t("settingsPage.agentAccess.automationRootPickerPending")
                          : t("settingsPage.agentAccess.automationRootPickerAction")}
                      </Button>
                    </Box>
                  ) : null}

                  {draft.permissions.manageProxiedVerification ? (
                    <Box sx={{ mt: 2 }}>
                      <ScopedOriginEditor
                        title={t("settingsPage.agentAccess.proxiedVerificationOriginsTitle")}
                        description={t(
                          "settingsPage.agentAccess.proxiedVerificationOriginsDescription",
                        )}
                        values={draft.proxiedVerificationOrigins}
                        disabled={busy}
                        placeholder={t("settingsPage.agentAccess.originPlaceholder")}
                        invalidMessage={t("settingsPage.agentAccess.originInvalid")}
                        addLabel={t("settingsPage.agentAccess.originAdd")}
                        emptyLabel={t("settingsPage.agentAccess.originEmpty")}
                        onAdd={(origin) => addOrigin("proxiedVerificationOrigins", origin)}
                        onRemove={(origin) => removeOrigin("proxiedVerificationOrigins", origin)}
                      />
                    </Box>
                  ) : null}
                  {draft.permissions.manageProxiedVerification &&
                  hasUnmetPermissionDependencies(draft.permissions, "manageProxiedVerification") ? (
                    <Alert severity="warning" variant="outlined" sx={{ ...compactAlertSx, mt: 1 }}>
                      {t("settingsPage.agentAccess.proxiedVerificationRequiresAutomation")}
                    </Alert>
                  ) : null}

                  <Divider sx={{ mt: 1 }} />
                </>
              ) : null}
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
                        <AgentCapabilityModeSelect
                          capability="readRawBodies"
                          disabled={rawBodiesBlocked}
                          mode={capabilityMode(
                            draft.permissions,
                            draft.grantRequestPolicy,
                            "readRawBodies",
                          )}
                          onChange={(mode) => updateCapabilityMode("readRawBodies", mode)}
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
                              "aria-label": t(
                                "settingsPage.agentAccess.detectSensitiveValuesLabel",
                              ),
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
                          onChange={(event) =>
                            updateRedaction("hashIdentifiers", event.target.checked)
                          }
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
                                new Set(
                                  value.map((item) => item.trim().toLowerCase()).filter(Boolean),
                                ),
                              ),
                            )
                          }
                          renderInput={(params) => (
                            <TextField
                              {...params}
                              placeholder={t(
                                "settingsPage.agentAccess.customSensitiveKeysPlaceholder",
                              )}
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
                          onChange={(event) =>
                            updateLimit("maxSessions", Number(event.target.value))
                          }
                          inputProps={{
                            "aria-label": t("settingsPage.agentAccess.maxSessionsLabel"),
                          }}
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
                            updateLimit("maxBodyBytes", Number(event.target.value))
                          }
                          inputProps={{
                            "aria-label": t("settingsPage.agentAccess.maxBodyBytesLabel"),
                          }}
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
                      <Alert
                        severity="warning"
                        variant="outlined"
                        sx={{ ...compactAlertSx, mt: 1 }}
                      >
                        {t("settingsPage.agentAccess.rawBodiesWarning")}
                      </Alert>
                    ) : null}
                  </Box>
                </Collapse>
              </Box>
            </Box>
          </Collapse>

          <Box
            sx={{
              position: "sticky",
              bottom: 0,
              zIndex: 2,
              bgcolor: "background.paper",
              borderTop: 1,
              borderColor: "divider",
            }}
          >
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
                <Button size="small" disabled={busy} onClick={() => setChangesOpen(true)}>
                  {t("settingsPage.agentAccess.viewChanges")}
                </Button>
              ) : null}
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
          </Box>
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
          path: pendingConfigInstall?.info.configPath ?? "",
        })}
        confirmLabel={t("settingsPage.agentAccess.configInstallConfirm")}
        isConfirming={configMutation.isPending}
        onCancel={() => setPendingConfigInstall(null)}
        onConfirm={() => {
          if (pendingConfigInstall) {
            configMutation.mutate({ client: pendingConfigInstall.info.client });
          }
        }}
      />

      <AgentConnectDialog
        busy={connectMutation.isPending}
        clientLabel={pendingConnect ? clientName(pendingConnect.info.client, t) : ""}
        currentPermissions={draft?.permissions ?? permissionsForPreset("readOnly")}
        errorMessage={connectError}
        info={pendingConnect?.info ?? null}
        onCancel={() => {
          if (connectMutation.isPending) return;
          setPendingConnect(null);
          setConnectError(null);
        }}
        onChangePreset={(preset) => {
          setConnectError(null);
          setPendingConnect((current) => (current ? { ...current, preset } : current));
        }}
        onConfirm={() => {
          if (!pendingConnect) return;
          startConnect({
            info: pendingConnect.info,
            preset: pendingConnect.preset,
          });
        }}
        open={pendingConnect !== null}
        preset={pendingConnect?.preset ?? "readOnly"}
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

      <ConfirmDialog
        open={pendingRemove !== null}
        title={t("settingsPage.agentAccess.disconnectTitle", {
          client: pendingRemove ? clientName(pendingRemove.client, t) : "",
        })}
        message={t("settingsPage.agentAccess.disconnectMessage", {
          path: pendingRemove?.configPath ?? "",
          skillPath: pendingRemove?.skillPath ?? "",
        })}
        confirmColor="error"
        confirmLabel={t("settingsPage.agentAccess.disconnectConfirm")}
        isConfirming={removeMutation.isPending}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) removeMutation.mutate(pendingRemove);
        }}
      />

      <ConfirmDialog
        confirmColor="error"
        confirmLabel={t("settingsPage.agentAccess.immediateRevokeConfirm")}
        isConfirming={revokeControlMutation.isPending}
        message={t("settingsPage.agentAccess.immediateRevokeMessage")}
        onCancel={() => setRevokeControlOpen(false)}
        onConfirm={() => revokeControlMutation.mutate()}
        open={revokeControlOpen}
        title={t("settingsPage.agentAccess.immediateRevokeTitle")}
      />

      <ConfirmDialog
        confirmColor="error"
        confirmLabel={t("settingsPage.agentAccess.grantRevoke")}
        isConfirming={revokeGrantMutation.isPending}
        message={t("settingsPage.agentAccess.grantRevokeMessage", {
          capability: pendingRevokeGrant
            ? t(permissionDefinition(pendingRevokeGrant.capability).labelKey)
            : "",
          client: pendingRevokeGrant?.clientName ?? "",
        })}
        onCancel={() => setPendingRevokeGrant(null)}
        onConfirm={() => {
          if (pendingRevokeGrant) revokeGrantMutation.mutate(pendingRevokeGrant);
        }}
        open={pendingRevokeGrant !== null}
        title={t("settingsPage.agentAccess.grantRevokeTitle")}
      />

      <Dialog fullWidth maxWidth="sm" onClose={() => setChangesOpen(false)} open={changesOpen}>
        <DialogTitle>{t("settingsPage.agentAccess.changesTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
            {t("settingsPage.agentAccess.changesDescription")}
          </Typography>
          {changeItems.length === 0 ? (
            <Typography variant="body2">{t("settingsPage.agentAccess.changesEmpty")}</Typography>
          ) : (
            <Stack divider={<Divider flexItem />} spacing={0}>
              {changeItems.map((item) => (
                <Stack key={item.id} spacing={0.25} sx={{ py: 1 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 0 }}>
                      {item.label}
                    </Typography>
                    {item.highRisk ? (
                      <Chip
                        size="small"
                        color={item.risk === "destructive" ? "error" : "warning"}
                        variant="outlined"
                        label={t(permissionRiskKey(item.risk ?? "traffic"))}
                      />
                    ) : null}
                  </Stack>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {item.before} → {item.after}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setChangesOpen(false)}>{t("common.actions.close")}</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        confirmColor="warning"
        confirmLabel={t("settingsPage.agentAccess.bulkGrantConfirm")}
        message={t("settingsPage.agentAccess.bulkGrantMessage", {
          count: availablePermissionDefinitions().length,
          permissions: availablePermissionDefinitions()
            .map((definition) => t(definition.labelKey))
            .join(" · "),
        })}
        onCancel={() => setBulkGrantOpen(false)}
        onConfirm={enableAllAvailablePermissions}
        open={bulkGrantOpen}
        title={t("settingsPage.agentAccess.bulkGrantTitle")}
      />

      <ConfirmDialog
        confirmColor="warning"
        confirmLabel={t("settingsPage.agentAccess.highRiskConnectConfirm")}
        isConfirming={connectMutation.isPending}
        message={t("settingsPage.agentAccess.highRiskSaveMessage", {
          permissions: pendingHighRiskConnect?.items.map((item) => item.label).join(" · ") ?? "",
        })}
        onCancel={() => {
          const input = pendingHighRiskConnect?.input;
          setPendingHighRiskConnect(null);
          if (input) setPendingConnect(input);
        }}
        onConfirm={() => {
          if (!pendingHighRiskConnect) return;
          const input = pendingHighRiskConnect.input;
          setPendingHighRiskConnect(null);
          connectMutation.mutate(input);
        }}
        open={pendingHighRiskConnect !== null}
        title={t("settingsPage.agentAccess.highRiskConnectTitle")}
      />

      <ConfirmDialog
        confirmColor="warning"
        confirmLabel={t("settingsPage.agentAccess.highRiskSaveConfirm")}
        isConfirming={saveMutation.isPending}
        message={t("settingsPage.agentAccess.highRiskSaveMessage", {
          permissions: highRiskChangeItems.map((item) => item.label).join(" · "),
        })}
        onCancel={() => setPendingHighRiskSave(null)}
        onConfirm={() => {
          if (!pendingHighRiskSave) return;
          saveMutation.mutate(pendingHighRiskSave);
        }}
        open={pendingHighRiskSave !== null}
        title={t("settingsPage.agentAccess.highRiskSaveTitle")}
      />

      <ConfirmDialog
        confirmColor="warning"
        confirmLabel={t("settingsPage.agentAccess.unsavedLeaveConfirm")}
        isConfirming={false}
        message={t("settingsPage.agentAccess.unsavedLeaveMessage")}
        onCancel={unsavedGuard.handleCancel}
        onConfirm={unsavedGuard.handleConfirm}
        open={unsavedGuard.dialogOpen}
        title={t("settingsPage.agentAccess.unsavedLeaveTitle")}
      />
    </Stack>
  );
}

function RevokeResultCard({
  cleanupPending,
  onClose,
  onManageCertificates,
  onRestoreProxy,
  onStopCapture,
  onViewRules,
  result,
}: {
  cleanupPending: boolean;
  onClose: () => void;
  onManageCertificates: () => void;
  onRestoreProxy: () => void;
  onStopCapture: () => void;
  onViewRules: () => void;
  result: RevokeAgentControlResult;
}) {
  const { t } = useI18n();
  const effects: string[] = [];
  if (result.activeEffects.captureRunning) {
    effects.push(
      t("settingsPage.agentAccess.revokeEffectCapture", {
        workspace: result.activeEffects.workspaceId ?? "default",
      }),
    );
  }
  if (result.activeEffects.systemProxyEnabled) {
    effects.push(t("settingsPage.agentAccess.revokeEffectProxy"));
  }
  if (result.activeEffects.certificateTrusted) {
    effects.push(t("settingsPage.agentAccess.revokeEffectCertificate"));
  }
  if (
    result.activeEffects.agentRuleCount > 0 ||
    result.activeEffects.agentAutomationResourceCount > 0
  ) {
    effects.push(
      t("settingsPage.agentAccess.revokeEffectResources", {
        rules: result.activeEffects.agentRuleCount,
        automation: result.activeEffects.agentAutomationResourceCount,
      }),
    );
  }

  return (
    <SectionCard
      compact
      title={t("settingsPage.agentAccess.revokeResultTitle")}
      description={t("settingsPage.agentAccess.immediateRevokeMessage")}
      toolbar={
        <Button size="small" onClick={onClose}>
          {t("common.actions.close")}
        </Button>
      }
    >
      <Stack spacing={1.5}>
        <Stack direction={{ sm: "row", xs: "column" }} spacing={1.5}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2">
              {t("settingsPage.agentAccess.revokeResultRevoked")}
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {capabilityNames(result.revokedCapabilities, t)}
            </Typography>
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2">
              {t("settingsPage.agentAccess.revokeResultRetained")}
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {capabilityNames(result.retainedReadCapabilities, t)}
            </Typography>
          </Box>
        </Stack>
        <Alert severity={effects.length > 0 ? "warning" : "success"} variant="outlined">
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            {t("settingsPage.agentAccess.revokeEffectsTitle")}
          </Typography>
          <Stack spacing={0.25}>
            {(effects.length > 0 ? effects : [t("settingsPage.agentAccess.revokeEffectNone")]).map(
              (effect) => (
                <Typography key={effect} variant="body2">
                  {effect}
                </Typography>
              ),
            )}
          </Stack>
        </Alert>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {result.activeEffects.captureRunning ? (
            <Button
              size="small"
              variant="outlined"
              disabled={cleanupPending}
              onClick={onStopCapture}
            >
              {t("settingsPage.agentAccess.revokeStopCapture")}
            </Button>
          ) : null}
          {result.activeEffects.systemProxyEnabled ? (
            <Button
              size="small"
              variant="outlined"
              disabled={cleanupPending}
              onClick={onRestoreProxy}
            >
              {t("settingsPage.agentAccess.revokeRestoreProxy")}
            </Button>
          ) : null}
          {result.activeEffects.certificateTrusted ? (
            <Button size="small" variant="outlined" onClick={onManageCertificates}>
              {t("settingsPage.agentAccess.revokeViewCertificate")}
            </Button>
          ) : null}
          {result.activeEffects.agentRuleCount > 0 ||
          result.activeEffects.agentAutomationResourceCount > 0 ? (
            <Button size="small" variant="outlined" onClick={onViewRules}>
              {t("settingsPage.agentAccess.revokeViewAutomation")}
            </Button>
          ) : null}
        </Stack>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {result.grantsCleared
            ? t("settingsPage.agentAccess.revokeGrantsCleared")
            : t("settingsPage.agentAccess.revokeGrantsNotCleared")}
        </Typography>
      </Stack>
    </SectionCard>
  );
}

function capabilityNames(
  capabilities: readonly AgentCapability[],
  t: ReturnType<typeof useI18n>["t"],
) {
  if (capabilities.length === 0) return "—";
  return capabilities.map((capability) => t(permissionDefinition(capability).labelKey)).join(" · ");
}

function CapabilitySummary({
  dirty,
  enabled,
  grantRequestPolicy,
  onAdjust,
  onRevokeControl,
  permissions,
  revokeBusy,
}: {
  dirty: boolean;
  enabled: boolean;
  grantRequestPolicy: UpdateAgentAccessSettingsInput["grantRequestPolicy"];
  onAdjust: () => void;
  onRevokeControl: () => void;
  permissions: AgentAccessPermissions;
  revokeBusy: boolean;
}) {
  const { t } = useI18n();
  const readDefinitions = enabledPermissionDefinitions(permissions, { group: "readData" });
  const controlDefinitions = (
    ["controlDesktop", "modifyRequests", "agentAutomation", "dangerous"] as const
  )
    .flatMap((group) => enabledPermissionDefinitions(permissions, { group }))
    .filter((definition) => definition.available);
  const requestDefinitions = availablePermissionDefinitions().filter(
    (definition) => !permissions[definition.key] && grantRequestPolicy[definition.key] === "ask",
  );

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        p: 1.5,
      }}
    >
      <Stack
        direction={{ sm: "row", xs: "column" }}
        spacing={1}
        sx={{ alignItems: { sm: "center", xs: "stretch" }, justifyContent: "space-between" }}
      >
        <Typography variant="subtitle2">
          {t("settingsPage.agentAccess.capabilitySummaryTitle")}
        </Typography>
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Button size="small" variant="outlined" onClick={onAdjust}>
            {t("settingsPage.agentAccess.adjustPermissions")}
          </Button>
          <Button
            size="small"
            color="error"
            variant="outlined"
            disabled={revokeBusy}
            onClick={onRevokeControl}
          >
            {revokeBusy
              ? t("settingsPage.agentAccess.saving")
              : t("settingsPage.agentAccess.immediateRevoke")}
          </Button>
        </Stack>
      </Stack>
      {enabled ? (
        <Stack spacing={0.75} sx={{ mt: 1 }}>
          <CapabilitySummaryLine
            emptyLabel={t("settingsPage.agentAccess.capabilitySummaryNoRead")}
            label={t("settingsPage.agentAccess.capabilitySummaryReadLabel")}
            values={permissionLabels(readDefinitions, t)}
          />
          <CapabilitySummaryLine
            emptyLabel={t("settingsPage.agentAccess.capabilitySummaryNoControl")}
            label={t("settingsPage.agentAccess.capabilitySummaryControlLabel")}
            values={permissionLabels(controlDefinitions, t)}
          />
          <CapabilitySummaryLine
            emptyLabel={t("settingsPage.agentAccess.capabilitySummaryNoRequest")}
            label={t("settingsPage.agentAccess.capabilitySummaryRequestLabel")}
            values={permissionLabels(requestDefinitions, t)}
          />
        </Stack>
      ) : (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
          {t("settingsPage.agentAccess.capabilitySummaryDisabled")}
        </Typography>
      )}
      {dirty ? (
        <Typography variant="caption" sx={{ color: "warning.main", display: "block", mt: 1 }}>
          {t("settingsPage.agentAccess.capabilitySummarySavedOnly")}
        </Typography>
      ) : null}
    </Box>
  );
}

function CapabilitySummaryLine({
  emptyLabel,
  label,
  values,
}: {
  emptyLabel: string;
  label: string;
  values: string;
}) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
      <Typography variant="caption" sx={{ color: "text.secondary", flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {values || emptyLabel}
      </Typography>
    </Stack>
  );
}

function permissionLabels(
  definitions: readonly { labelKey: ReturnType<typeof permissionDefinition>["labelKey"] }[],
  t: ReturnType<typeof useI18n>["t"],
) {
  const visible = definitions.slice(0, 4).map((definition) => t(definition.labelKey));
  if (definitions.length > visible.length) {
    visible.push(
      t("settingsPage.agentAccess.capabilitySummaryMore", {
        count: definitions.length - visible.length,
      }),
    );
  }
  return visible.join(" · ");
}

function PermissionGroupHeading({
  group,
  insideGroup = false,
  permissions,
}: {
  group: AgentPermissionGroupId;
  insideGroup?: boolean;
  permissions: AgentAccessPermissions;
}) {
  const { t } = useI18n();
  const definition = AGENT_PERMISSION_GROUPS.find((candidate) => candidate.id === group);
  if (!definition) return null;
  const count = countEnabledPermissions(permissions, { group, surface: "standard" });
  const total = availablePermissionDefinitions({ group, surface: "standard" }).length;

  return (
    <Box sx={{ pt: insideGroup ? 1.5 : 0.25, pb: insideGroup ? 1 : 0, minWidth: 0 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start", justifyContent: "space-between" }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2">{t(definition.labelKey)}</Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t(definition.descriptionKey)}
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
          <Chip
            size="small"
            variant="outlined"
            color={definition.risk === "destructive" ? "error" : "default"}
            label={t(permissionRiskKey(definition.risk))}
          />
          <Chip size="small" label={`${count}/${total}`} />
        </Stack>
      </Stack>
    </Box>
  );
}

function AgentCheckList({ result, onCopy }: { result: AgentAccessTestResult; onCopy: () => void }) {
  const { t } = useI18n();
  const hasError = result.checks.some((check) => check.status === "error");
  const hasWarning = result.checks.some((check) => check.status === "warning");
  return (
    <Stack spacing={0.75} sx={{ pt: 0.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <Typography
          variant="caption"
          sx={{
            color: hasError ? "error.main" : hasWarning ? "warning.main" : "success.main",
            fontWeight: 600,
          }}
        >
          {hasError
            ? t("settingsPage.agentAccess.checksFailed")
            : hasWarning
              ? t("settingsPage.agentAccess.checksWarning")
              : t("settingsPage.agentAccess.checksPassed")}
        </Typography>
        <Button size="small" color="inherit" onClick={onCopy} sx={{ minHeight: 28, px: 0.75 }}>
          {t("settingsPage.agentAccess.copyDiagnostics")}
        </Button>
      </Stack>
      {result.checks.map((check) => (
        <Stack key={check.id} direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
          <Box sx={{ display: "flex", pt: 0.25 }}>
            {check.status === "ok" ? (
              <CheckCircleRoundedIcon color="success" sx={{ fontSize: 16 }} />
            ) : check.status === "warning" ? (
              <WarningAmberRoundedIcon color="warning" sx={{ fontSize: 16 }} />
            ) : (
              <ErrorOutlineRoundedIcon color="error" sx={{ fontSize: 16 }} />
            )}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ lineHeight: 1.4 }}>
              {checkLabel(check.id, t)}
            </Typography>
            {check.detail ? (
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", display: "block", overflowWrap: "anywhere" }}
              >
                {check.detail}
              </Typography>
            ) : null}
          </Box>
        </Stack>
      ))}
    </Stack>
  );
}

function checkLabel(id: string, t: ReturnType<typeof useI18n>["t"]) {
  switch (id) {
    case "sidecar":
      return t("settingsPage.agentAccess.checkSidecar");
    case "doctor":
      return t("settingsPage.agentAccess.checkDoctor");
    case "dataDirectory":
      return t("settingsPage.agentAccess.checkDataDirectory");
    case "database":
      return t("settingsPage.agentAccess.checkDatabase");
    case "schema":
      return t("settingsPage.agentAccess.checkSchema");
    case "agentAccessEnabled":
      return t("settingsPage.agentAccess.checkEnabled");
    case "bodyAccess":
      return t("settingsPage.agentAccess.checkBodyAccess");
    case "handshake":
      return t("settingsPage.agentAccess.checkHandshake");
    case "tools":
      return t("settingsPage.agentAccess.checkTools");
    case "sessions":
      return t("settingsPage.agentAccess.checkSessions");
    case "clients":
      return t("settingsPage.agentAccess.checkClients");
    case "controlChannel":
      return t("settingsPage.agentAccess.checkControlChannel");
    case "controlPermissions":
      return t("settingsPage.agentAccess.checkControlPermissions");
    default:
      return id;
  }
}

function FeedbackAlert({ feedback }: { feedback: Feedback }) {
  return (
    <Alert severity={feedback.severity} variant="outlined" sx={compactAlertSx}>
      {feedback.message}
    </Alert>
  );
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
  connectMutation: { isPending: boolean; variables?: ConnectInput | undefined },
  configMutation: {
    isPending: boolean;
    variables?: { client: AgentClientInfo["client"] } | undefined;
  },
  skillMutation: { isPending: boolean; variables?: SkillMutationInput | undefined },
  removeMutation: { isPending: boolean; variables?: AgentClientInfo | undefined },
) {
  if (connectMutation.isPending) return connectMutation.variables?.info.client ?? null;
  if (configMutation.isPending) return configMutation.variables?.client ?? null;
  if (skillMutation.isPending) return skillMutation.variables?.info.client ?? null;
  if (removeMutation.isPending) return removeMutation.variables?.client ?? null;
  return null;
}

function activeMutationAction(
  connectMutation: { isPending: boolean },
  configMutation: { isPending: boolean },
  skillMutation: { isPending: boolean },
  removeMutation: { isPending: boolean },
): AgentClientPendingAction | null {
  if (connectMutation.isPending) return "connect";
  if (configMutation.isPending) return "config";
  if (skillMutation.isPending) return "skill";
  if (removeMutation.isPending) return "remove";
  return null;
}

function ScopedOriginEditor({
  addLabel,
  description,
  disabled,
  emptyLabel,
  invalidMessage,
  onAdd,
  onRemove,
  placeholder,
  title,
  values,
}: {
  addLabel: string;
  description: string;
  disabled: boolean;
  emptyLabel: string;
  invalidMessage: string;
  onAdd: (origin: string) => void;
  onRemove: (origin: string) => void;
  placeholder: string;
  title: string;
  values: string[];
}) {
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);

  function submit() {
    const normalized = normalizeOrigin(input);
    if (!normalized) {
      setInvalid(true);
      return;
    }
    onAdd(normalized);
    setInput("");
    setInvalid(false);
  }

  return (
    <Box>
      <Typography variant="subtitle2">{title}</Typography>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {description}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start", mt: 1 }}>
        <TextField
          size="small"
          fullWidth
          value={input}
          error={invalid}
          helperText={invalid ? invalidMessage : undefined}
          placeholder={placeholder}
          disabled={disabled || values.length >= 50}
          onChange={(event) => {
            setInput(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <Button
          size="small"
          variant="outlined"
          disabled={disabled || !input.trim() || values.length >= 50}
          onClick={submit}
          sx={{ minWidth: 72 }}
        >
          {addLabel}
        </Button>
      </Stack>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
        {values.map((origin) => (
          <Chip
            key={origin}
            label={origin}
            onDelete={disabled ? undefined : () => onRemove(origin)}
            deleteIcon={<DeleteOutlineRoundedIcon />}
            sx={{ fontFamily: "monospace" }}
          />
        ))}
      </Stack>
      {values.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
          {emptyLabel}
        </Typography>
      ) : null}
    </Box>
  );
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function buildAgentAccessChangeItems(
  saved: AgentAccessDraft,
  current: AgentAccessDraft,
  t: ReturnType<typeof useI18n>["t"],
): AgentAccessChangeItem[] {
  const items: AgentAccessChangeItem[] = [];
  if (saved.enabled !== current.enabled) {
    items.push({
      id: "enabled",
      kind: "enabled",
      label: t("settingsPage.agentAccess.enabledLabel"),
      before: saved.enabled
        ? t("settingsPage.agentAccess.changeOn")
        : t("settingsPage.agentAccess.changeOff"),
      after: current.enabled
        ? t("settingsPage.agentAccess.changeOn")
        : t("settingsPage.agentAccess.changeOff"),
      highRisk: false,
    });
  }

  for (const key of AGENT_PERMISSION_KEYS) {
    const definition = permissionDefinition(key);
    const beforeMode = capabilityMode(saved.permissions, saved.grantRequestPolicy, key);
    const afterMode = capabilityMode(current.permissions, current.grantRequestPolicy, key);
    if (saved.permissions[key] !== current.permissions[key]) {
      items.push({
        id: `permission:${key}`,
        kind: "permission",
        label: t(definition.labelKey),
        before: t(capabilityModeLabelKey(beforeMode)),
        after: t(capabilityModeLabelKey(afterMode)),
        highRisk: definition.confirmOnEnable && !saved.permissions[key] && current.permissions[key],
        risk: definition.risk,
      });
    } else if (beforeMode !== afterMode) {
      items.push({
        id: `grant-policy:${key}`,
        kind: "policy",
        label: t(definition.labelKey),
        before: t(capabilityModeLabelKey(beforeMode)),
        after: t(capabilityModeLabelKey(afterMode)),
        highRisk: definition.confirmOnEnable && beforeMode === "deny",
        risk: definition.risk,
      });
    }
  }

  const limitFields: Array<{ key: keyof AgentAccessLimits; labelKey: TranslationKey }> = [
    { key: "maxSessions", labelKey: "settingsPage.agentAccess.maxSessionsLabel" },
    { key: "maxBodyBytes", labelKey: "settingsPage.agentAccess.maxBodyBytesLabel" },
  ];
  for (const field of limitFields) {
    if (saved.limits[field.key] === current.limits[field.key]) continue;
    items.push({
      id: `limit:${field.key}`,
      kind: "policy",
      label: t(field.labelKey),
      before: String(saved.limits[field.key]),
      after: String(current.limits[field.key]),
      highRisk: false,
    });
  }

  const redactionBooleanFields: Array<{
    key: "detectSensitiveValues" | "hashIdentifiers";
    labelKey: TranslationKey;
  }> = [
    {
      key: "detectSensitiveValues",
      labelKey: "settingsPage.agentAccess.detectSensitiveValuesLabel",
    },
    { key: "hashIdentifiers", labelKey: "settingsPage.agentAccess.hashIdentifiersLabel" },
  ];
  for (const field of redactionBooleanFields) {
    if (saved.redaction[field.key] === current.redaction[field.key]) continue;
    items.push({
      id: `redaction:${field.key}`,
      kind: "policy",
      label: t(field.labelKey),
      before: saved.redaction[field.key]
        ? t("settingsPage.agentAccess.changeOn")
        : t("settingsPage.agentAccess.changeOff"),
      after: current.redaction[field.key]
        ? t("settingsPage.agentAccess.changeOn")
        : t("settingsPage.agentAccess.changeOff"),
      highRisk: false,
    });
  }
  if (
    saved.redaction.customSensitiveKeys.join("\u0000") !==
    current.redaction.customSensitiveKeys.join("\u0000")
  ) {
    items.push({
      id: "redaction:customSensitiveKeys",
      kind: "policy",
      label: t("settingsPage.agentAccess.customSensitiveKeysLabel"),
      before: saved.redaction.customSensitiveKeys.join(", ") || "—",
      after: current.redaction.customSensitiveKeys.join(", ") || "—",
      highRisk: false,
    });
  }

  appendCollectionChanges(
    items,
    "automation-root",
    t("settingsPage.agentAccess.automationRootsTitle"),
    saved.automationApprovedRoots,
    current.automationApprovedRoots,
    t,
  );
  appendCollectionChanges(
    items,
    "proxied-origin",
    t("settingsPage.agentAccess.proxiedVerificationOriginsTitle"),
    saved.proxiedVerificationOrigins,
    current.proxiedVerificationOrigins,
    t,
  );

  return items;
}

function appendCollectionChanges(
  items: AgentAccessChangeItem[],
  idPrefix: string,
  label: string,
  before: readonly string[],
  after: readonly string[],
  t: ReturnType<typeof useI18n>["t"],
) {
  const added = after.filter((value) => !before.includes(value));
  const removed = before.filter((value) => !after.includes(value));
  for (const value of added) {
    items.push({
      id: `${idPrefix}:added:${value}`,
      kind: "scope",
      label: `${label}: ${value}`,
      before: "—",
      after: t("settingsPage.agentAccess.changeAdded"),
      highRisk: false,
    });
  }
  for (const value of removed) {
    items.push({
      id: `${idPrefix}:removed:${value}`,
      kind: "scope",
      label: `${label}: ${value}`,
      before: t("settingsPage.agentAccess.changeRemoved"),
      after: "—",
      highRisk: false,
    });
  }
}

function draftFromSettings(settings: AgentAccessSettings): AgentAccessDraft {
  return {
    enabled: settings.enabled,
    permissions: { ...settings.permissions },
    grantRequestPolicy: { ...settings.grantRequestPolicy },
    limits: { ...settings.limits },
    redaction: {
      ...settings.redaction,
      customSensitiveKeys: [...settings.redaction.customSensitiveKeys],
      customPatterns: settings.redaction.customPatterns.map((rule) => ({ ...rule })),
    },
    automationApprovedRoots: [...settings.automationApprovedRoots],
    proxiedVerificationOrigins: [...settings.proxiedVerificationOrigins],
    automationCrossHostOrigins: [...settings.automationCrossHostOrigins],
  };
}

function draftAccessSnapshot(draft: AgentAccessDraft): PermissionDraftSnapshot {
  return {
    permissions: { ...draft.permissions },
    grantRequestPolicy: { ...draft.grantRequestPolicy },
  };
}

function permissionDraftSnapshotsEqual(
  current: PermissionDraftSnapshot,
  next: PermissionDraftSnapshot,
) {
  return (
    permissionsEqual(current.permissions, next.permissions) &&
    AGENT_PERMISSION_KEYS.every(
      (key) => current.grantRequestPolicy[key] === next.grantRequestPolicy[key],
    )
  );
}

function draftsEqual(current: AgentAccessDraft, saved: AgentAccessDraft) {
  if (current.enabled !== saved.enabled) return false;
  const limitKeys: Array<keyof AgentAccessLimits> = [
    "maxSessions",
    "maxBodyBytes",
    "maxResponseBytes",
  ];
  return (
    AGENT_PERMISSION_KEYS.every((key) => current.permissions[key] === saved.permissions[key]) &&
    AGENT_PERMISSION_KEYS.every(
      (key) => current.grantRequestPolicy[key] === saved.grantRequestPolicy[key],
    ) &&
    limitKeys.every((key) => current.limits[key] === saved.limits[key]) &&
    JSON.stringify(current.redaction) === JSON.stringify(saved.redaction) &&
    JSON.stringify(current.automationApprovedRoots) ===
      JSON.stringify(saved.automationApprovedRoots) &&
    JSON.stringify(current.proxiedVerificationOrigins) ===
      JSON.stringify(saved.proxiedVerificationOrigins) &&
    JSON.stringify(current.automationCrossHostOrigins) ===
      JSON.stringify(saved.automationCrossHostOrigins)
  );
}
