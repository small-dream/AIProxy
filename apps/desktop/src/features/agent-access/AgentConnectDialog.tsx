import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from "@mui/material";

import type { AgentClientInfo } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";

import { permissionsForPreset, type AgentPermissionPreset } from "./agent-access.helpers";

const PRESETS: AgentPermissionPreset[] = ["metadata", "bodies", "raw"];

type AgentConnectDialogProps = {
  busy: boolean;
  clientLabel: string;
  errorMessage?: string | null;
  info: AgentClientInfo | null;
  onCancel: () => void;
  onChangePreset: (preset: AgentPermissionPreset) => void;
  onConfirm: () => void;
  open: boolean;
  preset: AgentPermissionPreset;
};

/**
 * Scope chooser shown before writing a client's MCP config. Picking a preset
 * both persists the matching permissions and writes the config, so the user
 * never connects a client with an unclear read scope.
 */
export function AgentConnectDialog({
  busy,
  clientLabel,
  errorMessage,
  info,
  onCancel,
  onChangePreset,
  onConfirm,
  open,
  preset,
}: AgentConnectDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog fullWidth maxWidth="sm" onClose={onCancel} open={open}>
      <DialogTitle>
        {t("settingsPage.agentAccess.connectDialogTitle", { client: clientLabel })}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", overflowWrap: "anywhere" }}
          >
            {t("settingsPage.agentAccess.connectDialogPath", { path: info?.configPath ?? "" })}
          </Typography>
          {info?.configExists ? (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("settingsPage.agentAccess.connectDialogBackup")}
            </Typography>
          ) : null}

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              {t("settingsPage.agentAccess.connectDialogScopeTitle")}
            </Typography>
            <RadioGroup
              aria-label={t("settingsPage.agentAccess.connectDialogScopeTitle")}
              value={preset}
              onChange={(_, value) => onChangePreset(value as AgentPermissionPreset)}
            >
              {PRESETS.map((option) => (
                <FormControlLabel
                  key={option}
                  disabled={busy}
                  value={option}
                  control={<Radio size="small" />}
                  label={
                    <Box>
                      <Typography variant="body2">{presetLabel(option, t)}</Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {presetDescription(option, t)}
                      </Typography>
                    </Box>
                  }
                  sx={{ alignItems: "flex-start", m: 0, py: 0.5 }}
                />
              ))}
            </RadioGroup>
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", display: "block", mt: 0.5 }}
            >
              {t("settingsPage.agentAccess.connectDialogScopeHint", {
                permissions: permissionsSummary(permissionsForPreset(preset), t),
              })}
            </Typography>
          </Box>

          {preset === "raw" ? (
            <Alert severity="warning" variant="outlined" sx={{ py: 0.5 }}>
              {t("settingsPage.agentAccess.rawBodiesWarning")}
            </Alert>
          ) : null}
          <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
            {t("settingsPage.agentAccess.connectDataFlowNote")}
          </Alert>
          {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button disabled={busy} onClick={onCancel}>
          {t("common.actions.cancel")}
        </Button>
        <Button disabled={busy} onClick={onConfirm} variant="contained">
          {t("settingsPage.agentAccess.connectDialogConfirm")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function presetLabel(preset: AgentPermissionPreset, t: ReturnType<typeof useI18n>["t"]) {
  switch (preset) {
    case "metadata":
      return t("settingsPage.agentAccess.presetMetadata");
    case "bodies":
      return t("settingsPage.agentAccess.presetBodies");
    case "raw":
      return t("settingsPage.agentAccess.presetRaw");
  }
}

function presetDescription(preset: AgentPermissionPreset, t: ReturnType<typeof useI18n>["t"]) {
  switch (preset) {
    case "metadata":
      return t("settingsPage.agentAccess.presetMetadataDescription");
    case "bodies":
      return t("settingsPage.agentAccess.presetBodiesDescription");
    case "raw":
      return t("settingsPage.agentAccess.presetRawDescription");
  }
}

function permissionsSummary(
  permissions: ReturnType<typeof permissionsForPreset>,
  t: ReturnType<typeof useI18n>["t"],
) {
  const parts = [t("settingsPage.agentAccess.readSessionsLabel")];
  if (permissions.readWebSocket) parts.push(t("settingsPage.agentAccess.readWebSocketLabel"));
  if (permissions.readRawBodies) {
    parts.push(t("settingsPage.agentAccess.readRawBodiesLabel"));
  } else if (permissions.readBodies) {
    parts.push(t("settingsPage.agentAccess.readBodiesLabel"));
  }
  return parts.join(" · ");
}
