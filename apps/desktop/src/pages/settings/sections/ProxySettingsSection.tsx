import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import { Alert, Button, Switch, TextField, Typography } from "@mui/material";
import { useEffect, useMemo, useState } from "react";

import {
  DEFAULT_PROXY_PORT,
  DEFAULT_WORKSPACE_ID,
  coerceAppError,
  type Workspace,
} from "@aiproxy/shared-types";

import { SectionCard } from "@/components/shared/SectionCard";
import { useProxyStatus, useStartProxy } from "@/features/proxy-status/use-proxy-status";
import { useUpdateWorkspace, useWorkspaces } from "@/features/workspace-manager/use-workspaces";
import { useI18n } from "@/i18n";
import { compactAlertSx, SettingsFooter, SettingsGroup, SettingsRow } from "../SettingsLayoutParts";

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

export function ProxySettingsSection() {
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
