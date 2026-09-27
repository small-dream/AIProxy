import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import InfoRoundedIcon from "@mui/icons-material/InfoRounded";
import NetworkCheckRoundedIcon from "@mui/icons-material/NetworkCheckRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";

import {
  DEFAULT_WORKSPACE_ID,
  coerceAppError,
  type UpstreamProxyProbeResult,
  type UpstreamProxyProtocol,
  type UpstreamProxySettings,
  type Workspace,
} from "@aiproxy/shared-types";

import { SectionCard } from "@/components/shared/SectionCard";
import { useProxyStatus, useStartProxy } from "@/features/proxy-status/use-proxy-status";
import { useUpdateWorkspace, useWorkspaces } from "@/features/workspace-manager/use-workspaces";
import { useI18n } from "@/i18n";
import { testUpstreamProxy } from "@/services/commands";
import { compactAlertSx, compactFieldSx, SettingsRow } from "../SettingsLayoutParts";

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

/** The pristine draft, used to detect "user changed something" on a workspace
 * that has never configured an upstream proxy. */
function createUpstreamProxyDraftSettings(): UpstreamProxySettings {
  return upstreamProxyDraftToSettings(createUpstreamProxyDraft());
}

export function UpstreamProxySection() {
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
    setTestResult(null);
  }, [currentWorkspace]);

  // Clear feedback only when the workspace identity changes, not its content:
  // the post-save refetch produces a new object for the same id, and wiping
  // feedback there would erase the success message handleSave just set.
  const feedbackResetKey = currentWorkspace?.id ?? null;
  useEffect(() => {
    setFeedback(null);
  }, [feedbackResetKey]);

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

        <SettingsRow
          label={t("upstreamProxy.bypass")}
          description={t("upstreamProxy.bypassDescription")}
          stacked
        >
          <TextField
            size="small"
            multiline
            fullWidth
            minRows={2}
            maxRows={5}
            hiddenLabel
            placeholder={t("upstreamProxy.bypassPlaceholder")}
            value={draft.bypassText}
            onChange={(event) => patchDraft({ bypassText: event.target.value })}
            slotProps={{ htmlInput: { "aria-label": t("upstreamProxy.bypass") } }}
            sx={{ ...compactFieldSx, width: "100%" }}
          />
        </SettingsRow>

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
