import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import InfoRoundedIcon from "@mui/icons-material/InfoRounded";
import NetworkCheckRoundedIcon from "@mui/icons-material/NetworkCheckRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import SystemUpdateAltRoundedIcon from "@mui/icons-material/SystemUpdateAltRounded";
import {
  Alert,
  Box,
  Button,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  coerceAppError,
  DEFAULT_PROXY_PORT,
  DEFAULT_WORKSPACE_ID,
  type SaveAiSettingsInput,
  type SslProxyingSettings,
  type UpstreamProxyProbeResult,
  type UpstreamProxyProtocol,
  type UpstreamProxySettings,
  type Workspace,
} from "@aiproxy/shared-types";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { useAppShellStore } from "@/app/store/app-shell.store";
import { SectionCard } from "@/components/shared/SectionCard";
import { useProxyStatus, useStartProxy } from "@/features/proxy-status/use-proxy-status";
import { checkForUpdateAndStore, installUpdateAndStore } from "@/features/updater/update-status";
import { useUpdateWorkspace, useWorkspaces } from "@/features/workspace-manager/use-workspaces";
import { useI18n } from "@/i18n";
import { ensureNotificationPermission } from "@/services/notifications/system-notifications";
import {
  getAiSettings,
  getAppBuildInfo,
  loadDefaultSslProxyingExclusions,
  saveAiSettings,
  testAiConnection,
  testUpstreamProxy,
} from "@/services/commands";
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
    http2Enabled: workspace?.http2Enabled ?? true,
    // H3: upstream TLS verification. Default off (NoOp verifier) for backward
    // compatibility. tlsVerifyHosts is edited as a newline-delimited string in
    // the textarea; we serialize/deserialize against the workspace's array.
    verifyUpstreamTls: workspace?.verifyUpstreamTls ?? false,
    tlsVerifyHostsText: (workspace?.tlsVerifyHosts ?? []).join("\n"),
  };
}

/**
 * Parse the newline-delimited TLS verify hosts textarea into a clean,
 * de-duplicated array of trimmed non-empty hostnames. H3.
 */
function parseTlsVerifyHosts(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of text.split("\n")) {
    const host = raw.trim();
    if (host.length === 0 || seen.has(host)) continue;
    seen.add(host);
    result.push(host);
  }
  return result;
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

const rowControlSx = {
  flexShrink: 0,
  width: { sm: 320, xs: "100%" },
};

const selectControlSx = {
  ...rowControlSx,
  "& .MuiInputBase-root": { minHeight: 36 },
};

const compactFieldSx = {
  "& .MuiInputBase-root": { minHeight: 36 },
};

/**
 * One settings row in the macOS-style grouped list: a plain-language label
 * (plus optional description) on the left, the control pinned to the right.
 * `stacked` drops the control onto its own line for wide inputs such as the
 * TLS host list.
 */
function SettingsRow({
  label,
  description,
  hint,
  stacked = false,
  children,
}: {
  label: string;
  description?: string;
  hint?: ReactNode;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: { xs: "column", sm: stacked ? "column" : "row" },
        alignItems: { xs: "stretch", sm: stacked ? "stretch" : "flex-start" },
        justifyContent: "space-between",
        gap: { xs: 1, sm: 3 },
        py: 1.5,
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1, pt: { sm: stacked ? 0 : 0.25 } }}>
        <Typography variant="body2" sx={{ fontWeight: 500, lineHeight: 1.45 }}>
          {label}
        </Typography>
        {description ? (
          <Typography
            variant="caption"
            sx={{ display: "block", color: "text.secondary", lineHeight: 1.5, mt: 0.25 }}
          >
            {description}
          </Typography>
        ) : null}
        {hint}
      </Box>
      {children}
    </Box>
  );
}

/** Divider-separated list of settings rows inside a SectionCard. */
function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <Stack spacing={0} divider={<Divider />}>
      {children}
    </Stack>
  );
}

/** Footer row of a group: quiet hint text on the left, actions on the right. */
function SettingsFooter({ hint, children }: { hint?: ReactNode; children: ReactNode }) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: { xs: "column", sm: "row" },
        alignItems: { xs: "stretch", sm: "center" },
        justifyContent: "space-between",
        gap: 1.5,
        py: 1.5,
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>{hint}</Box>
      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        {children}
      </Stack>
    </Box>
  );
}

const AI_SETTINGS_QUERY_KEY = ["ai-settings"];
const AI_DEFAULT_TEMPERATURE = 0.2;
const AI_DEFAULT_TIMEOUT_MS = 60_000;

function ProxySettingsSection() {
  const { t } = useI18n();
  const { data: workspaces = [], isError: isWorkspacesError } = useWorkspaces();
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
  const [feedback, setFeedback] = useState<{
    severity: "error" | "success";
    message: string;
  } | null>(null);

  useEffect(() => {
    setDraft(createProxyDraft(currentWorkspace));
    setFeedback(null);
  }, [currentWorkspace]);

  async function handleSave() {
    if (isWorkspacesError || !currentWorkspace || portError) return;

    setFeedback(null);

    const tlsVerifyHosts = parseTlsVerifyHosts(draft.tlsVerifyHostsText);

    try {
      // H3: persist the verify flag + host allowlist. The backend serializes
      // the array to its JSON-encoded DB column; we send the array form so it
      // matches the Workspace.tlsVerifyHosts contract. Restarting the proxy
      // (below) applies the new verify mode to fresh connections.
      await updateWorkspaceMutation.mutateAsync({
        proxyPort: draft.proxyPort,
        sslEnabled: draft.sslEnabled,
        http2Enabled: draft.http2Enabled,
        verifyUpstreamTls: draft.verifyUpstreamTls,
        tlsVerifyHosts,
        workspaceId: currentWorkspace.id,
      });

      if (proxyStatus?.running) {
        await startProxyMutation.mutateAsync({
          enableSsl: draft.sslEnabled,
          enableHttp2: draft.http2Enabled,
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
  const portError =
    !Number.isInteger(draft.proxyPort) || draft.proxyPort < 1 || draft.proxyPort > 65535;
  const hasChanges = currentWorkspace
    ? currentWorkspace.proxyPort !== draft.proxyPort ||
      currentWorkspace.sslEnabled !== draft.sslEnabled ||
      currentWorkspace.http2Enabled !== draft.http2Enabled ||
      (currentWorkspace.verifyUpstreamTls ?? false) !== draft.verifyUpstreamTls ||
      parseTlsVerifyHosts(draft.tlsVerifyHostsText).join("\n") !==
        (currentWorkspace.tlsVerifyHosts ?? []).join("\n")
    : false;

  return (
    <SectionCard
      compact
      title={t("proxyPresets.title")}
      description={t("proxyPresets.description")}
    >
      {isWorkspacesError && (
        <Alert severity="error" variant="outlined" sx={{ ...compactAlertSx, mb: 1.5 }}>
          {t("common.errors.generic")}
        </Alert>
      )}
      <SettingsGroup>
        <SettingsRow label={t("proxyPresets.proxyPort")}>
          <TextField
            size="small"
            type="number"
            hiddenLabel
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
            slotProps={{
              htmlInput: {
                inputMode: "numeric",
                min: 1,
                max: 65535,
                "aria-label": t("proxyPresets.proxyPort"),
              },
            }}
            sx={{ flexShrink: 0, width: { sm: 140, xs: "100%" } }}
          />
        </SettingsRow>

        <SettingsRow label={t("proxyPresets.sslEnabled")}>
          <Switch
            size="small"
            checked={draft.sslEnabled}
            onChange={(event) => {
              setDraft({ ...draft, sslEnabled: event.target.checked });
              setFeedback(null);
            }}
          />
        </SettingsRow>

        <SettingsRow
          label={t("proxyPresets.http2Enabled")}
          description={t("proxyPresets.http2EnabledDescription")}
        >
          <Switch
            size="small"
            checked={draft.http2Enabled}
            onChange={(event) => {
              setDraft({ ...draft, http2Enabled: event.target.checked });
              setFeedback(null);
            }}
          />
        </SettingsRow>

        {/* H3: upstream TLS certificate verification opt-out. Off by default
            (the debug proxy accepts any upstream cert). Turning it on makes
            new HTTPS/WSS connections verify against the OS root store. */}
        <SettingsRow
          label={t("proxyPresets.verifyUpstreamTls")}
          description={t("proxyPresets.verifyUpstreamTlsDescription")}
          hint={
            !draft.verifyUpstreamTls ? (
              <Typography
                variant="caption"
                sx={{ display: "block", color: "warning.main", lineHeight: 1.5, mt: 0.5 }}
              >
                {t("proxyPresets.verifyUpstreamTlsDisabledHint")}
              </Typography>
            ) : null
          }
        >
          <Switch
            size="small"
            checked={draft.verifyUpstreamTls}
            onChange={(event) => {
              setDraft({ ...draft, verifyUpstreamTls: event.target.checked });
              setFeedback(null);
            }}
          />
        </SettingsRow>

        {draft.verifyUpstreamTls ? (
          <SettingsRow label={t("proxyPresets.tlsVerifyHosts")} stacked>
            <TextField
              size="small"
              multiline
              fullWidth
              minRows={2}
              maxRows={4}
              hiddenLabel
              placeholder={t("proxyPresets.tlsVerifyHostsPlaceholder")}
              value={draft.tlsVerifyHostsText}
              onChange={(event) => {
                setDraft({ ...draft, tlsVerifyHostsText: event.target.value });
                setFeedback(null);
              }}
              slotProps={{
                htmlInput: { "aria-label": t("proxyPresets.tlsVerifyHosts") },
              }}
            />
          </SettingsRow>
        ) : null}

        <SettingsFooter
          hint={
            <Typography variant="caption" sx={{ color: "text.secondary", lineHeight: 1.5 }}>
              {proxyStatus?.running ? t("proxyPresets.runningHint") : t("proxyPresets.stoppedHint")}
            </Typography>
          }
        >
          <Button
            size="small"
            variant="contained"
            startIcon={<SaveRoundedIcon />}
            onClick={() => void handleSave()}
            disabled={!currentWorkspace || portError || isBusy || !hasChanges || isWorkspacesError}
            sx={{ minHeight: 34, px: 1.75 }}
          >
            {isBusy ? t("proxyPresets.saving") : t("proxyPresets.save")}
          </Button>
        </SettingsFooter>
      </SettingsGroup>

      {feedback && (
        <Alert severity={feedback.severity} variant="outlined" sx={{ ...compactAlertSx, mt: 1 }}>
          {feedback.message}
        </Alert>
      )}

      {proxyStatus?.systemProxyRecoveryWarning ? (
        <Alert severity="warning" variant="outlined" sx={{ ...compactAlertSx, mt: 1 }}>
          {t("settingsPage.systemProxyRecoveryWarning", {
            message: proxyStatus.systemProxyRecoveryWarning,
          })}
        </Alert>
      ) : null}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Upstream (chained) proxy
// ---------------------------------------------------------------------------

const DEFAULT_UPSTREAM_PROXY_BYPASS = ["localhost", "127.0.0.1", "::1", "*.local"];

/** Default proxy port per protocol, used when switching the protocol select. */
const UPSTREAM_PROXY_DEFAULT_PORTS: Record<UpstreamProxyProtocol, number> = {
  http: 7890,
  https: 8443,
  socks5: 7891,
};

function createUpstreamProxyDraft(workspace?: Workspace | null) {
  const settings = workspace?.upstreamProxy;
  return {
    enabled: settings?.enabled ?? false,
    protocol: settings?.protocol ?? ("http" as UpstreamProxyProtocol),
    host: settings?.host ?? "127.0.0.1",
    // 7890 is Clash's default mixed (HTTP + SOCKS) port — the dominant case.
    port: settings?.port ?? 7890,
    username: settings?.username ?? "",
    password: settings?.password ?? "",
    bypassText: (settings?.bypass ?? DEFAULT_UPSTREAM_PROXY_BYPASS).join("\n"),
  };
}

type UpstreamProxyDraft = ReturnType<typeof createUpstreamProxyDraft>;

/**
 * Parse the newline-delimited bypass textarea into a clean, de-duplicated
 * array of trimmed non-empty patterns.
 */
function parseBypassPatterns(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of text.split("\n")) {
    const pattern = raw.trim();
    if (pattern.length === 0 || seen.has(pattern)) continue;
    seen.add(pattern);
    result.push(pattern);
  }
  return result;
}

/** Build the wire-format settings from the form draft. */
function upstreamProxyDraftToSettings(draft: UpstreamProxyDraft): UpstreamProxySettings {
  const username = draft.username.trim();
  return {
    enabled: draft.enabled,
    protocol: draft.protocol,
    host: draft.host.trim(),
    port: draft.port,
    // Empty strings become null so the backend does not advertise
    // username/password auth with nothing in it.
    username: username.length > 0 ? username : null,
    password: username.length > 0 && draft.password.length > 0 ? draft.password : null,
    bypass: parseBypassPatterns(draft.bypassText),
  };
}

function upstreamProxySettingsKey(settings: UpstreamProxySettings): string {
  return JSON.stringify([
    settings.enabled,
    settings.protocol,
    settings.host,
    settings.port,
    settings.username ?? "",
    settings.password ?? "",
    settings.bypass,
  ]);
}

function UpstreamProxySection() {
  const { t } = useI18n();
  const { data: workspaces = [], isError: isWorkspacesError } = useWorkspaces();
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

  const [draft, setDraft] = useState(createUpstreamProxyDraft());
  const [feedback, setFeedback] = useState<{
    severity: "error" | "success";
    message: string;
  } | null>(null);
  const [testResult, setTestResult] = useState<UpstreamProxyProbeResult | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    setDraft(createUpstreamProxyDraft(currentWorkspace));
    setFeedback(null);
    setTestResult(null);
  }, [currentWorkspace]);

  function patchDraft(patch: Partial<UpstreamProxyDraft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setFeedback(null);
    setTestResult(null);
  }

  const hostError = draft.enabled && draft.host.trim().length === 0;
  const portError = !Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535;
  const hasError = hostError || portError;

  const currentSettings = useMemo(() => upstreamProxyDraftToSettings(draft), [draft]);
  const savedSettings = currentWorkspace?.upstreamProxy;
  const hasChanges = savedSettings
    ? upstreamProxySettingsKey(savedSettings) !== upstreamProxySettingsKey(currentSettings)
    : // Never configured: only a non-default draft counts as a change.
      upstreamProxySettingsKey(createUpstreamProxyDraftSettings()) !==
      upstreamProxySettingsKey(currentSettings);

  async function handleTest() {
    if (hasError) return;
    setIsTesting(true);
    setFeedback(null);
    try {
      const result = await testUpstreamProxy({ settings: currentSettings });
      setTestResult(result);
    } catch (error) {
      const normalizedError = coerceAppError(error);
      setFeedback({
        message: normalizedError.message.trim() || t("common.errors.generic"),
        severity: "error",
      });
    } finally {
      setIsTesting(false);
    }
  }

  async function handleSave() {
    if (isWorkspacesError || !currentWorkspace || hasError) return;

    setFeedback(null);

    try {
      await updateWorkspaceMutation.mutateAsync({
        upstreamProxy: currentSettings,
        workspaceId: currentWorkspace.id,
      });

      // The upstream proxy is fixed for a proxy server's lifetime, so a running
      // proxy must be restarted for the change to take effect.
      if (proxyStatus?.running) {
        await startProxyMutation.mutateAsync({
          enableSsl: currentWorkspace.sslEnabled,
          enableHttp2: currentWorkspace.http2Enabled ?? true,
          port: currentWorkspace.proxyPort,
          workspaceId: currentWorkspace.id,
        });
      }

      setFeedback({
        message: proxyStatus?.running
          ? t("upstreamProxy.saveAndApplySuccess")
          : t("upstreamProxy.saveSuccess"),
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

  return (
    <SectionCard
      compact
      title={t("upstreamProxy.title")}
      description={t("upstreamProxy.description")}
    >
      <Stack spacing={1.5}>
        {isWorkspacesError && <Alert severity="error">{t("common.errors.generic")}</Alert>}

        <Stack
          direction={{ md: "row", xs: "column" }}
          spacing={1.5}
          sx={{
            alignItems: { md: "center", xs: "stretch" },
            justifyContent: "space-between",
          }}
        >
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={draft.enabled}
                onChange={(event) => patchDraft({ enabled: event.target.checked })}
              />
            }
            label={
              <Box>
                <Typography variant="body2">{t("upstreamProxy.enabled")}</Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {t("upstreamProxy.enabledDescription")}
                </Typography>
              </Box>
            }
            sx={{ ml: 0 }}
          />

          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<NetworkCheckRoundedIcon />}
              onClick={() => void handleTest()}
              disabled={hasError || isTesting || isBusy}
              sx={{ minHeight: 34, px: 1.75 }}
            >
              {isTesting ? t("upstreamProxy.testing") : t("upstreamProxy.test")}
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<SaveRoundedIcon />}
              onClick={() => void handleSave()}
              disabled={!currentWorkspace || hasError || isBusy || !hasChanges || isWorkspacesError}
              sx={{ minHeight: 34, px: 1.75 }}
            >
              {isBusy ? t("upstreamProxy.saving") : t("upstreamProxy.save")}
            </Button>
          </Stack>
        </Stack>

        <Stack
          direction={{ sm: "row", xs: "column" }}
          spacing={1.5}
          sx={{ alignItems: { sm: "flex-start", xs: "stretch" } }}
        >
          <FormControl size="small" sx={{ ...compactFieldSx, width: { sm: 160, xs: "100%" } }}>
            <InputLabel id="upstream-proxy-protocol-label">
              {t("upstreamProxy.protocol")}
            </InputLabel>
            <Select
              labelId="upstream-proxy-protocol-label"
              label={t("upstreamProxy.protocol")}
              value={draft.protocol}
              onChange={(event) => {
                const protocol = event.target.value as UpstreamProxyProtocol;
                // Move the port to the new protocol's default only when the
                // current value is still another protocol's default, so a
                // hand-typed port is never silently overwritten.
                const isDefaultPort = Object.values(UPSTREAM_PROXY_DEFAULT_PORTS).includes(
                  draft.port,
                );
                patchDraft({
                  protocol,
                  ...(isDefaultPort ? { port: UPSTREAM_PROXY_DEFAULT_PORTS[protocol] } : {}),
                });
              }}
            >
              <MenuItem value="http">{t("upstreamProxy.protocolHttp")}</MenuItem>
              <MenuItem value="https">{t("upstreamProxy.protocolHttps")}</MenuItem>
              <MenuItem value="socks5">{t("upstreamProxy.protocolSocks5")}</MenuItem>
            </Select>
          </FormControl>

          <TextField
            size="small"
            label={t("upstreamProxy.host")}
            value={draft.host}
            onChange={(event) => patchDraft({ host: event.target.value })}
            error={hostError}
            helperText={hostError ? t("upstreamProxy.hostValidation") : undefined}
            sx={{ ...compactFieldSx, flex: 1, minWidth: { sm: 200, xs: "100%" } }}
          />

          <TextField
            size="small"
            type="number"
            label={t("upstreamProxy.port")}
            value={draft.port}
            onChange={(event) => patchDraft({ port: Number(event.target.value) || 0 })}
            error={portError}
            helperText={portError ? t("upstreamProxy.portValidation") : undefined}
            slotProps={{ htmlInput: { inputMode: "numeric", min: 1, max: 65535 } }}
            sx={{ ...compactFieldSx, width: { sm: 140, xs: "100%" } }}
          />
        </Stack>

        <Stack
          direction={{ sm: "row", xs: "column" }}
          spacing={1.5}
          sx={{ alignItems: { sm: "flex-start", xs: "stretch" } }}
        >
          <TextField
            size="small"
            label={t("upstreamProxy.username")}
            placeholder={t("upstreamProxy.credentialsOptional")}
            value={draft.username}
            onChange={(event) => patchDraft({ username: event.target.value })}
            autoComplete="off"
            sx={{ ...compactFieldSx, flex: 1, minWidth: { sm: 180, xs: "100%" } }}
          />
          <TextField
            size="small"
            type="password"
            label={t("upstreamProxy.password")}
            placeholder={t("upstreamProxy.credentialsOptional")}
            value={draft.password}
            onChange={(event) => patchDraft({ password: event.target.value })}
            autoComplete="off"
            disabled={draft.username.trim().length === 0}
            helperText={
              draft.username.trim().length === 0
                ? t("upstreamProxy.passwordNeedsUsername")
                : undefined
            }
            sx={{ ...compactFieldSx, flex: 1, minWidth: { sm: 180, xs: "100%" } }}
          />
        </Stack>

        <TextField
          size="small"
          multiline
          minRows={2}
          maxRows={5}
          label={t("upstreamProxy.bypass")}
          placeholder={t("upstreamProxy.bypassPlaceholder")}
          helperText={t("upstreamProxy.bypassDescription")}
          value={draft.bypassText}
          onChange={(event) => patchDraft({ bypassText: event.target.value })}
          sx={{ ...compactFieldSx, width: "100%" }}
        />

        {testResult && (
          <Alert
            severity={testResult.success ? "success" : "error"}
            variant="outlined"
            icon={testResult.success ? <CheckCircleRoundedIcon /> : <InfoRoundedIcon />}
            sx={compactAlertSx}
          >
            {testResult.success
              ? t("upstreamProxy.testSuccess", {
                  target: testResult.probeTarget,
                  elapsed: String(testResult.elapsedMs),
                })
              : t("upstreamProxy.testFailure", {
                  error: testResult.error?.trim() || t("common.errors.generic"),
                })}
          </Alert>
        )}

        {draft.enabled && (
          <Alert severity="info" variant="outlined" icon={<InfoRoundedIcon />} sx={compactAlertSx}>
            {t("upstreamProxy.noFallbackHint")}
          </Alert>
        )}

        {draft.enabled && draft.password.length > 0 && (
          <Alert
            severity="warning"
            variant="outlined"
            icon={<InfoRoundedIcon />}
            sx={compactAlertSx}
          >
            {t("upstreamProxy.credentialStorageHint")}
          </Alert>
        )}

        {feedback && (
          <Alert severity={feedback.severity} variant="outlined" sx={compactAlertSx}>
            {feedback.message}
          </Alert>
        )}
      </Stack>
    </SectionCard>
  );
}

/** The pristine draft, used to detect "user changed something" on a workspace
 * that has never configured an upstream proxy. */
function createUpstreamProxyDraftSettings(): UpstreamProxySettings {
  return upstreamProxyDraftToSettings(createUpstreamProxyDraft());
}

/** Stable identity for "no patterns", so it can be used as an effect dependency. */
const EMPTY_PATTERNS: string[] = [];

function createSslProxyingDraft(
  workspace?: Workspace | null,
  fallbackExclude: string[] = EMPTY_PATTERNS,
) {
  const settings = workspace?.sslProxying;
  return {
    includeText: (settings?.include ?? []).join("\n"),
    // A workspace that never configured a policy shows the recommended
    // exclusions, matching what the backend would actually apply.
    excludeText: (settings?.exclude ?? fallbackExclude).join("\n"),
  };
}

type SslProxyingDraft = ReturnType<typeof createSslProxyingDraft>;

function sslProxyingDraftToSettings(draft: SslProxyingDraft): SslProxyingSettings {
  return {
    include: parseBypassPatterns(draft.includeText),
    exclude: parseBypassPatterns(draft.excludeText),
  };
}

function sslProxyingSettingsKey(settings: SslProxyingSettings): string {
  return JSON.stringify([settings.include, settings.exclude]);
}

function SslProxyingSection() {
  const { t } = useI18n();
  const { data: workspaces = [], isError: isWorkspacesError } = useWorkspaces();
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

  // Served by the backend so the recommended list has one source of truth.
  const { data } = useQuery({
    queryKey: ["ssl-proxying", "default-exclusions"],
    queryFn: loadDefaultSslProxyingExclusions,
    staleTime: Infinity,
  });
  // Fall back to a module-level constant rather than a fresh `[]`: this value
  // is an effect dependency, and a new array identity on every render would
  // re-run the effect, call setDraft, and render again without end.
  const recommendedExclusions = data ?? EMPTY_PATTERNS;

  const [draft, setDraft] = useState(createSslProxyingDraft());
  const [feedback, setFeedback] = useState<{
    severity: "error" | "success";
    message: string;
  } | null>(null);

  useEffect(() => {
    setDraft(createSslProxyingDraft(currentWorkspace, recommendedExclusions));
    setFeedback(null);
  }, [currentWorkspace, recommendedExclusions]);

  function patchDraft(patch: Partial<SslProxyingDraft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setFeedback(null);
  }

  const currentSettings = useMemo(() => sslProxyingDraftToSettings(draft), [draft]);
  const savedSettings = currentWorkspace?.sslProxying;
  const hasChanges = savedSettings
    ? sslProxyingSettingsKey(savedSettings) !== sslProxyingSettingsKey(currentSettings)
    : sslProxyingSettingsKey({ include: [], exclude: recommendedExclusions }) !==
      sslProxyingSettingsKey(currentSettings);

  // Interception has to be on for the policy to mean anything; saying so is
  // better than letting the user tune a list that is currently inert.
  const isSslDisabled = currentWorkspace ? !currentWorkspace.sslEnabled : false;
  const isAllowlistMode = currentSettings.include.length > 0;

  async function handleSave() {
    if (isWorkspacesError || !currentWorkspace) return;

    setFeedback(null);

    try {
      await updateWorkspaceMutation.mutateAsync({
        sslProxying: currentSettings,
        workspaceId: currentWorkspace.id,
      });

      // The policy is captured when the server starts, so a running proxy has
      // to be restarted before the change takes effect.
      if (proxyStatus?.running) {
        await startProxyMutation.mutateAsync({
          enableSsl: currentWorkspace.sslEnabled,
          enableHttp2: currentWorkspace.http2Enabled ?? true,
          port: currentWorkspace.proxyPort,
          workspaceId: currentWorkspace.id,
        });
      }

      setFeedback({
        message: proxyStatus?.running
          ? t("sslProxying.saveAndApplySuccess")
          : t("sslProxying.saveSuccess"),
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

  return (
    <SectionCard compact title={t("sslProxying.title")} description={t("sslProxying.description")}>
      <Stack spacing={1.5}>
        {isWorkspacesError && <Alert severity="error">{t("common.errors.generic")}</Alert>}

        {isSslDisabled && (
          <Alert severity="info" variant="outlined" icon={<InfoRoundedIcon />} sx={compactAlertSx}>
            {t("sslProxying.sslDisabledHint")}
          </Alert>
        )}

        <Stack
          direction={{ md: "row", xs: "column" }}
          spacing={1.5}
          sx={{
            alignItems: { md: "center", xs: "stretch" },
            justifyContent: "space-between",
          }}
        >
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {isAllowlistMode
              ? t("sslProxying.modeIncludeList")
              : t("sslProxying.modeAllExceptExcluded")}
          </Typography>

          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<RestartAltRoundedIcon />}
              onClick={() => patchDraft({ excludeText: recommendedExclusions.join("\n") })}
              disabled={isBusy || recommendedExclusions.length === 0}
              sx={{ minHeight: 34, px: 1.75 }}
            >
              {t("sslProxying.restoreRecommended")}
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<SaveRoundedIcon />}
              onClick={() => void handleSave()}
              disabled={!currentWorkspace || isBusy || !hasChanges || isWorkspacesError}
              sx={{ minHeight: 34, px: 1.75 }}
            >
              {isBusy ? t("sslProxying.saving") : t("sslProxying.save")}
            </Button>
          </Stack>
        </Stack>

        <TextField
          size="small"
          multiline
          minRows={2}
          maxRows={6}
          label={t("sslProxying.include")}
          placeholder={t("sslProxying.includePlaceholder")}
          helperText={t("sslProxying.includeDescription")}
          value={draft.includeText}
          onChange={(event) => patchDraft({ includeText: event.target.value })}
          sx={{ ...compactFieldSx, width: "100%" }}
        />

        <TextField
          size="small"
          multiline
          minRows={3}
          maxRows={10}
          label={t("sslProxying.exclude")}
          placeholder={t("sslProxying.excludePlaceholder")}
          helperText={t("sslProxying.excludeDescription")}
          value={draft.excludeText}
          onChange={(event) => patchDraft({ excludeText: event.target.value })}
          sx={{ ...compactFieldSx, width: "100%" }}
        />

        <Alert severity="info" variant="outlined" icon={<InfoRoundedIcon />} sx={compactAlertSx}>
          {t("sslProxying.pinningHint")}
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

export function UpdatesSection() {
  const { t } = useI18n();
  const availableUpdate = useAppShellStore((s) => s.availableUpdate);
  const isChecking = useAppShellStore((s) => s.isChecking);
  const isInstalling = useAppShellStore((s) => s.isInstalling);
  const updateProgress = useAppShellStore((s) => s.updateProgress);
  const [checkToast, setCheckToast] = useState<{
    message: string;
    severity: "success" | "error";
  } | null>(null);

  async function handleCheck() {
    const ok = await checkForUpdateAndStore();
    if (!ok) {
      setCheckToast({ message: t("common.errors.generic"), severity: "error" });
      return;
    }
    if (useAppShellStore.getState().availableUpdate === null) {
      setCheckToast({ message: t("settingsPage.updatesNone"), severity: "success" });
    }
  }

  async function handleInstall() {
    try {
      await installUpdateAndStore();
    } catch {
      // helper logs + resets isInstalling
    }
  }

  const progressText =
    updateProgress && updateProgress.contentLength
      ? t("settingsPage.updatesProgress", {
          downloaded: Math.round(updateProgress.downloaded / 1024).toString(),
          total: Math.round(updateProgress.contentLength / 1024).toString(),
        })
      : null;

  return (
    <SectionCard
      compact
      title={t("settingsPage.updatesSectionTitle")}
      description={t("settingsPage.updatesDescription")}
    >
      <SettingsGroup>
        <SettingsFooter
          hint={
            <Box sx={{ minWidth: 0 }}>
              <Typography
                variant="body2"
                sx={{ color: availableUpdate ? "text.primary" : "text.secondary" }}
              >
                {availableUpdate
                  ? t("settingsPage.updatesAvailableDetail", {
                      currentVersion: availableUpdate.currentVersion,
                      version: availableUpdate.version,
                    })
                  : t("settingsPage.updatesIdle")}
              </Typography>
              {progressText ? (
                <Typography
                  variant="caption"
                  sx={{ display: "block", color: "text.secondary", mt: 0.25 }}
                >
                  {progressText}
                </Typography>
              ) : null}
            </Box>
          }
        >
          <Button
            size="small"
            variant="outlined"
            startIcon={<SystemUpdateAltRoundedIcon />}
            onClick={() => void handleCheck()}
            disabled={isChecking || isInstalling}
            sx={{ minHeight: 34, px: 1.75 }}
          >
            {isChecking
              ? t("settingsPage.updatesCheckingAction")
              : t("settingsPage.updatesCheckAction")}
          </Button>

          {availableUpdate ? (
            <Button
              size="small"
              variant="contained"
              startIcon={<DownloadRoundedIcon />}
              onClick={() => void handleInstall()}
              disabled={isChecking || isInstalling}
              sx={{ minHeight: 34, px: 1.75 }}
            >
              {isInstalling
                ? t("settingsPage.updatesInstallingAction")
                : t("settingsPage.updatesInstallAction")}
            </Button>
          ) : null}
        </SettingsFooter>
      </SettingsGroup>

      <Snackbar
        open={checkToast !== null}
        autoHideDuration={3000}
        onClose={() => setCheckToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={checkToast?.severity ?? "success"}
          variant="filled"
          onClose={() => setCheckToast(null)}
        >
          {checkToast?.message}
        </Alert>
      </Snackbar>
    </SectionCard>
  );
}

function AiModelSettingsSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: AI_SETTINGS_QUERY_KEY,
    queryFn: getAiSettings,
  });
  const saveMutation = useMutation({
    mutationFn: (input: SaveAiSettingsInput) => saveAiSettings(input),
    onSuccess: (nextSettings) => {
      queryClient.setQueryData(AI_SETTINGS_QUERY_KEY, nextSettings);
      setApiKeyDraft(nextSettings.maskedApiKey ?? "");
      setApiKeyDraftDirty(false);
      setFeedback({ severity: "success", message: t("settingsPage.aiSaveSuccess") });
    },
    onError: (error) => {
      setFeedback({
        severity: "error",
        message: coerceAppError(error).message || t("common.errors.generic"),
      });
    },
  });
  const testMutation = useMutation({
    mutationFn: testAiConnection,
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
  });
  const [draft, setDraft] = useState<SaveAiSettingsInput>({
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    temperature: AI_DEFAULT_TEMPERATURE,
    timeoutMs: AI_DEFAULT_TIMEOUT_MS,
  });
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyDraftDirty, setApiKeyDraftDirty] = useState(false);
  const [feedback, setFeedback] = useState<{
    severity: "error" | "info" | "success";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!settings) {
      return;
    }

    setDraft({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: settings.temperature,
      timeoutMs: settings.timeoutMs,
    });
    setApiKeyDraft(settings.maskedApiKey ?? "");
    setApiKeyDraftDirty(false);
  }, [settings]);

  function handleSave(clearApiKey = false) {
    saveMutation.mutate({
      ...draft,
      apiKey: apiKeyDraftDirty ? apiKeyDraft : undefined,
      clearApiKey,
    });
  }

  const modelError = draft.model.trim().length === 0;
  const baseUrlError = draft.baseUrl.trim().length === 0;
  const busy = saveMutation.isPending || testMutation.isPending;

  return (
    <SectionCard
      compact
      title={t("settingsPage.aiSectionTitle")}
      description={t("settingsPage.aiSectionDescription")}
    >
      <SettingsGroup>
        <SettingsRow label={t("settingsPage.aiProvider")}>
          <Select
            size="small"
            value={draft.provider}
            onChange={(event) =>
              setDraft({
                ...draft,
                provider: event.target.value as SaveAiSettingsInput["provider"],
              })
            }
            inputProps={{ "aria-label": t("settingsPage.aiProvider") }}
            sx={selectControlSx}
          >
            <MenuItem value="openai-compatible">OpenAI-compatible</MenuItem>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("settingsPage.aiBaseUrl")}>
          <TextField
            size="small"
            hiddenLabel
            value={draft.baseUrl}
            error={baseUrlError}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            slotProps={{ htmlInput: { "aria-label": t("settingsPage.aiBaseUrl") } }}
            sx={selectControlSx}
          />
        </SettingsRow>

        <SettingsRow label={t("settingsPage.aiModel")}>
          <TextField
            size="small"
            hiddenLabel
            value={draft.model}
            error={modelError}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            slotProps={{ htmlInput: { "aria-label": t("settingsPage.aiModel") } }}
            sx={selectControlSx}
          />
        </SettingsRow>

        <SettingsRow label={t("settingsPage.aiApiKey")}>
          <TextField
            size="small"
            hiddenLabel
            placeholder={t("settingsPage.aiApiKeyPlaceholder")}
            type={apiKeyDraftDirty ? "password" : "text"}
            value={apiKeyDraft}
            onFocus={() => {
              if (!apiKeyDraftDirty && settings?.hasApiKey) {
                setApiKeyDraft("");
              }
            }}
            onBlur={() => {
              if (!apiKeyDraftDirty && settings?.maskedApiKey) {
                setApiKeyDraft(settings.maskedApiKey);
              }
            }}
            onChange={(event) => {
              setApiKeyDraft(event.target.value);
              setApiKeyDraftDirty(true);
            }}
            slotProps={{ htmlInput: { "aria-label": t("settingsPage.aiApiKey") } }}
            sx={selectControlSx}
          />
        </SettingsRow>

        <SettingsFooter>
          <Button
            size="small"
            variant="outlined"
            disabled={busy || !settings?.hasApiKey}
            onClick={() => handleSave(true)}
            sx={{ minHeight: 34 }}
          >
            {t("settingsPage.aiClearKey")}
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={busy || !settings?.hasApiKey}
            onClick={() => testMutation.mutate()}
            sx={{ minHeight: 34 }}
          >
            {testMutation.isPending ? t("settingsPage.aiTesting") : t("settingsPage.aiTest")}
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<SaveRoundedIcon />}
            disabled={busy || modelError || baseUrlError}
            onClick={() => handleSave(false)}
            sx={{ minHeight: 34, px: 1.75 }}
          >
            {saveMutation.isPending ? t("proxyPresets.saving") : t("proxyPresets.save")}
          </Button>
        </SettingsFooter>
      </SettingsGroup>

      {feedback ? (
        <Alert severity={feedback.severity} variant="outlined" sx={{ ...compactAlertSx, mt: 1 }}>
          {feedback.message}
        </Alert>
      ) : null}
    </SectionCard>
  );
}

function AboutSection() {
  const { t } = useI18n();
  const { data: buildInfo } = useQuery({
    queryKey: ["app-build-info"],
    queryFn: getAppBuildInfo,
  });
  const version = buildInfo?.version ?? "0.1.0";
  const buildNumber = buildInfo?.buildNumber ?? "0";
  const versionIdentifier = buildInfo?.versionIdentifier ?? `${version}+${buildNumber}`;
  const commitHash = buildInfo?.commitHash ?? "dev";

  return (
    <SectionCard
      compact
      title={t("settingsPage.aboutSectionTitle")}
      description={t("settingsPage.aboutSectionDescription")}
    >
      <SettingsGroup>
        <BuildInfoRow label={t("settingsPage.aboutVersion")} value={version} />
        <BuildInfoRow label={t("settingsPage.aboutBuildNumber")} value={buildNumber} />
        <BuildInfoRow label={t("settingsPage.aboutCommitHash")} value={commitHash} />
        <BuildInfoRow label={t("settingsPage.aboutVersionIdentifier")} value={versionIdentifier} />
      </SettingsGroup>
    </SectionCard>
  );
}

function BuildInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <SettingsRow label={label}>
      <Typography
        component="code"
        sx={{
          bgcolor: "action.hover",
          borderRadius: 1,
          fontFamily: "monospace",
          fontSize: 13,
          lineHeight: 1.6,
          maxWidth: "100%",
          overflowWrap: "anywhere",
          px: 1,
          py: 0.5,
        }}
      >
        {value}
      </Typography>
    </SettingsRow>
  );
}

export function SettingsPage() {
  const { preference, setPreference, t } = useI18n();
  const skipClearSessionsConfirm = useAppPreferencesStore(
    (state) => state.skipClearSessionsConfirm,
  );
  const setSkipClearSessionsConfirm = useAppPreferencesStore(
    (state) => state.setSkipClearSessionsConfirm,
  );
  const breakpointSystemNotifications = useAppPreferencesStore(
    (state) => state.breakpointSystemNotifications,
  );
  const setBreakpointSystemNotifications = useAppPreferencesStore(
    (state) => state.setBreakpointSystemNotifications,
  );
  const contentCustomFontFamily = useAppPreferencesStore((state) => state.contentCustomFontFamily);
  const contentFontPreference = useAppPreferencesStore((state) => state.contentFontPreference);
  const fontFamilyPreference = useAppPreferencesStore((state) => state.fontFamilyPreference);
  const fontSizePreference = useAppPreferencesStore((state) => state.fontSizePreference);
  const uiCustomFontFamily = useAppPreferencesStore((state) => state.uiCustomFontFamily);
  const setContentCustomFontFamily = useAppPreferencesStore(
    (state) => state.setContentCustomFontFamily,
  );
  const setContentFontPreference = useAppPreferencesStore(
    (state) => state.setContentFontPreference,
  );
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
    <Stack spacing={2} sx={{ maxWidth: 860, mx: "auto", width: "100%" }}>
      <Stack spacing={0.25}>
        <Typography variant="h4" sx={{ fontSize: 30, lineHeight: 1.15 }}>
          {t("settingsPage.title")}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {t("settingsPage.description")}
        </Typography>
      </Stack>
      <ProxySettingsSection />
      <UpstreamProxySection />
      <SslProxyingSection />
      <AiModelSettingsSection />
      <SectionCard compact title={t("settingsPage.generalSectionTitle")}>
        <SettingsGroup>
          <SettingsRow label={t("settingsPage.languageLabel")}>
            <Select
              size="small"
              value={preference}
              onChange={(event) => setPreference(event.target.value as typeof preference)}
              inputProps={{ "aria-label": t("settingsPage.languageLabel") }}
              sx={selectControlSx}
            >
              <MenuItem value="system">{t("settingsPage.languageOptionSystem")}</MenuItem>
              <MenuItem value="zh-CN">{t("settingsPage.languageOptionZhCN")}</MenuItem>
              <MenuItem value="en">{t("settingsPage.languageOptionEn")}</MenuItem>
            </Select>
          </SettingsRow>

          <SettingsRow label={t("settingsPage.themeLabel")}>
            <Select
              size="small"
              value={themePreference}
              onChange={(event) => setThemePreference(event.target.value as typeof themePreference)}
              inputProps={{ "aria-label": t("settingsPage.themeLabel") }}
              sx={selectControlSx}
            >
              <MenuItem value="system">{t("settingsPage.themeOptionSystem")}</MenuItem>
              <MenuItem value="light">{t("settingsPage.themeOptionLight")}</MenuItem>
              <MenuItem value="dark">{t("settingsPage.themeOptionDark")}</MenuItem>
            </Select>
          </SettingsRow>

          <SettingsRow label={t("settingsPage.fontLabel")}>
            <Select
              size="small"
              value={fontFamilyPreference}
              onChange={(event) => setFontFamilyPreference(event.target.value as AppFontPreference)}
              inputProps={{ "aria-label": t("settingsPage.fontLabel") }}
              sx={selectControlSx}
            >
              {appFontPreferences.map((option) => (
                <MenuItem key={option} value={option}>
                  {fontOptionLabels[option]}
                </MenuItem>
              ))}
            </Select>
          </SettingsRow>

          {fontFamilyPreference === "custom" ? (
            <SettingsRow label={t("settingsPage.customFontLabel")}>
              <TextField
                size="small"
                hiddenLabel
                placeholder={t("settingsPage.customFontPlaceholder")}
                value={uiCustomFontFamily}
                onChange={(event) => setUiCustomFontFamily(event.target.value)}
                slotProps={{ htmlInput: { "aria-label": t("settingsPage.customFontLabel") } }}
                sx={selectControlSx}
              />
            </SettingsRow>
          ) : null}

          <SettingsRow label={t("settingsPage.contentFontLabel")}>
            <Select
              size="small"
              value={contentFontPreference}
              onChange={(event) =>
                setContentFontPreference(event.target.value as ContentFontPreference)
              }
              inputProps={{ "aria-label": t("settingsPage.contentFontLabel") }}
              sx={selectControlSx}
            >
              {contentFontPreferences.map((option) => (
                <MenuItem key={option} value={option}>
                  {contentFontOptionLabels[option]}
                </MenuItem>
              ))}
            </Select>
          </SettingsRow>

          {contentFontPreference === "custom" ? (
            <SettingsRow label={t("settingsPage.customContentFontLabel")}>
              <TextField
                size="small"
                hiddenLabel
                placeholder={t("settingsPage.customFontPlaceholder")}
                value={contentCustomFontFamily}
                onChange={(event) => setContentCustomFontFamily(event.target.value)}
                slotProps={{
                  htmlInput: { "aria-label": t("settingsPage.customContentFontLabel") },
                }}
                sx={selectControlSx}
              />
            </SettingsRow>
          ) : null}

          <SettingsRow label={t("settingsPage.fontSizeLabel")}>
            <Select
              size="small"
              value={fontSizePreference}
              onChange={(event) => setFontSizePreference(Number(event.target.value))}
              inputProps={{ "aria-label": t("settingsPage.fontSizeLabel") }}
              sx={{ ...selectControlSx, width: { sm: 140, xs: "100%" } }}
            >
              {appFontSizeOptions.map((size) => (
                <MenuItem key={size} value={size}>
                  {size}px
                </MenuItem>
              ))}
            </Select>
          </SettingsRow>
        </SettingsGroup>
      </SectionCard>
      <SectionCard
        compact
        title={t("settingsPage.confirmSectionTitle")}
        description={t("settingsPage.confirmSectionDescription")}
      >
        {/* Re-enables the confirmation dialog after the user ticked "don't ask
            again" in the Clear All Sessions dialog. See UI_GUIDELINES §11.4. */}
        <SettingsGroup>
          <SettingsRow
            label={t("settingsPage.clearSessionsConfirmLabel")}
            description={t("settingsPage.clearSessionsConfirmDescription")}
          >
            <Switch
              size="small"
              checked={!skipClearSessionsConfirm}
              onChange={(event) => setSkipClearSessionsConfirm(!event.target.checked)}
            />
          </SettingsRow>
        </SettingsGroup>
      </SectionCard>
      <SectionCard
        compact
        title={t("settingsPage.notificationsSectionTitle")}
        description={t("settingsPage.notificationsSectionDescription")}
      >
        {/* OS-level breakpoint notifications (review §4.3). Enabling runs a
            best-effort permission request; a denial degrades silently back to
            the in-app panel + toast channel. */}
        <SettingsGroup>
          <SettingsRow
            label={t("settingsPage.breakpointNotificationsLabel")}
            description={t("settingsPage.breakpointNotificationsDescription")}
          >
            <Switch
              size="small"
              checked={breakpointSystemNotifications}
              onChange={(event) => {
                const next = event.target.checked;
                setBreakpointSystemNotifications(next);
                if (next) {
                  void ensureNotificationPermission();
                }
              }}
            />
          </SettingsRow>
        </SettingsGroup>
      </SectionCard>
      <UpdatesSection />
      <AboutSection />
    </Stack>
  );
}
