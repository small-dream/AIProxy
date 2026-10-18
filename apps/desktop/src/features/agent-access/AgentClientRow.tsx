import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import CodeRoundedIcon from "@mui/icons-material/CodeRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import EditNoteRoundedIcon from "@mui/icons-material/EditNoteRounded";
import MoreHorizRoundedIcon from "@mui/icons-material/MoreHorizRounded";
import MouseRoundedIcon from "@mui/icons-material/MouseRounded";
import TerminalRoundedIcon from "@mui/icons-material/TerminalRounded";
import {
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useState } from "react";

import type { AgentClientInfo } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";

import {
  getAgentClientConnectionState,
  type AgentClientConnectionState,
} from "./agent-access.helpers";
import { AgentPathValue } from "./AgentPathValue";

export type AgentClientPendingAction = "config" | "connect" | "remove" | "skill";

type AgentClientRowProps = {
  busy: boolean;
  info: AgentClientInfo;
  itemId?: string | undefined;
  onConnect: (info: AgentClientInfo) => void;
  onCopyText: (value: string) => void;
  onInstallSkill: (info: AgentClientInfo) => void;
  onRemove: (info: AgentClientInfo) => void;
  onWriteConfig: (info: AgentClientInfo) => void;
  pendingAction?: AgentClientPendingAction | null | undefined;
};

export function AgentClientRow({
  busy,
  info,
  itemId,
  onConnect,
  onCopyText,
  onInstallSkill,
  onRemove,
  onWriteConfig,
  pendingAction,
}: AgentClientRowProps) {
  const { t } = useI18n();
  const [manualOpen, setManualOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const state = getAgentClientConnectionState(info);
  const clientLabel = clientName(info.client, t);
  const configPath = info.configPath;
  const statusLabel = statusText(state, t);
  const actionLabel =
    pendingAction === "connect"
      ? t("settingsPage.agentAccess.connecting")
      : pendingAction === "remove"
        ? t("settingsPage.agentAccess.disconnecting")
        : actionText(state, t);
  const meta = clientMeta(info.client, t);

  function closeMenu() {
    setMenuAnchor(null);
  }

  return (
    <Box id={itemId} data-settings-item={itemId} sx={{ py: 1.5, scrollMarginTop: 24 }}>
      <Stack
        direction={{ sm: "row", xs: "column" }}
        spacing={1.5}
        sx={{ alignItems: { sm: "center", xs: "stretch" } }}
      >
        <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", flex: 1, minWidth: 0 }}>
          <Box
            sx={{
              alignItems: "center",
              bgcolor: "action.hover",
              borderRadius: 1.25,
              color: "text.secondary",
              display: "flex",
              flexShrink: 0,
              height: 36,
              justifyContent: "center",
              width: 36,
            }}
          >
            {clientIcon(info.client)}
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.4 }}>
                {clientLabel}
              </Typography>
              <Chip
                size="small"
                variant="outlined"
                color={statusColor(state)}
                label={statusLabel}
                sx={{ height: 22, "& .MuiChip-label": { px: 0.75, fontSize: 11.5 } }}
              />
            </Stack>
            <Tooltip
              title={`${meta} · ${configPath}`}
              placement="bottom-start"
              slotProps={{ tooltip: { sx: { maxWidth: 520, overflowWrap: "anywhere" } } }}
            >
              <Typography
                variant="caption"
                noWrap
                sx={{ color: "text.secondary", display: "block", mt: 0.25 }}
              >
                {`${meta} · ${configPath}`}
              </Typography>
            </Tooltip>
          </Box>
        </Stack>

        <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", flexShrink: 0 }}>
          <Button
            size="small"
            variant={state === "connected" ? "outlined" : "contained"}
            disabled={busy}
            onClick={() => onConnect(info)}
            sx={{ minHeight: 34, minWidth: 104 }}
          >
            {actionLabel}
          </Button>
          <Tooltip title={t("settingsPage.agentAccess.moreActions")}>
            <IconButton
              size="small"
              aria-label={`${t("settingsPage.agentAccess.moreActions")}: ${clientLabel}`}
              aria-haspopup="menu"
              aria-expanded={menuAnchor ? "true" : "false"}
              disabled={busy}
              onClick={(event) => setMenuAnchor(event.currentTarget)}
            >
              <MoreHorizRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={closeMenu}
        slotProps={{ paper: { sx: { borderRadius: 1.5, minWidth: 220 } } }}
      >
        <MenuItem
          onClick={() => {
            closeMenu();
            onWriteConfig(info);
          }}
        >
          <EditNoteRoundedIcon fontSize="small" sx={{ mr: 1 }} />
          {t("settingsPage.agentAccess.writeConfigOnly")}
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeMenu();
            onInstallSkill(info);
          }}
        >
          <DownloadRoundedIcon fontSize="small" sx={{ mr: 1 }} />
          {t("settingsPage.agentAccess.installSkillOnly")}
        </MenuItem>
        <MenuItem
          onClick={() => {
            closeMenu();
            setManualOpen((current) => !current);
          }}
        >
          <CodeRoundedIcon fontSize="small" sx={{ mr: 1 }} />
          {manualOpen
            ? t("settingsPage.agentAccess.hideManualConfig")
            : t("settingsPage.agentAccess.manualConfigToggle")}
        </MenuItem>
        {state === "notConnected" ? null : (
          <>
            <Divider />
            <MenuItem
              onClick={() => {
                closeMenu();
                onRemove(info);
              }}
              sx={{ color: "error.main" }}
            >
              <DeleteOutlineRoundedIcon fontSize="small" sx={{ mr: 1 }} />
              {t("settingsPage.agentAccess.disconnect")}
            </MenuItem>
          </>
        )}
      </Menu>

      <Collapse in={manualOpen} unmountOnExit>
        <Box
          sx={{
            bgcolor: "action.hover",
            border: 1,
            borderColor: "divider",
            borderRadius: 1.5,
            ml: { sm: 5.75, xs: 0 },
            mt: 1.5,
            p: 1.75,
          }}
        >
          <Stack spacing={1.25}>
            <Typography variant="caption" sx={{ color: "text.secondary", lineHeight: 1.5 }}>
              {t("settingsPage.agentAccess.manualConfigDescription")}
            </Typography>
            <Stack spacing={0.75}>
              <AgentPathValue
                copyLabel={t("settingsPage.agentAccess.copyPath")}
                label={t("settingsPage.agentAccess.configPath")}
                onCopy={onCopyText}
                value={configPath}
              />
              <AgentPathValue
                copyLabel={t("settingsPage.agentAccess.copyPath")}
                label={t("settingsPage.agentAccess.skillPath")}
                onCopy={onCopyText}
                value={info.skillPath}
              />
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {info.skillVersion && info.skillVersion !== info.bundledSkillVersion
                  ? t("settingsPage.agentAccess.skillVersionOutdated", {
                      installed: info.skillVersion,
                      bundled: info.bundledSkillVersion,
                    })
                  : !info.skillInstalled && info.skillManaged
                    ? t("settingsPage.agentAccess.skillVersionUnknown", {
                        bundled: info.bundledSkillVersion,
                      })
                    : t("settingsPage.agentAccess.skillVersionCurrent", {
                        version: info.bundledSkillVersion,
                      })}
              </Typography>
            </Stack>
            <Box
              component="pre"
              sx={{
                bgcolor: "background.paper",
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                fontSize: 12,
                lineHeight: 1.55,
                m: 0,
                maxHeight: 220,
                overflow: "auto",
                overflowWrap: "anywhere",
                p: 1.5,
                whiteSpace: "pre-wrap",
              }}
            >
              {info.configSnippet}
            </Box>
            <Stack
              direction={{ sm: "row", xs: "column" }}
              spacing={1}
              sx={{
                alignItems: { sm: "center", xs: "flex-start" },
                justifyContent: "space-between",
              }}
            >
              <Typography variant="caption" sx={{ color: "text.secondary", minWidth: 0 }}>
                {clientHint(info.client, t)}
              </Typography>
              <Button
                size="small"
                variant="outlined"
                disabled={busy}
                onClick={() => onCopyText(info.configSnippet)}
                sx={{ flexShrink: 0, minHeight: 32 }}
              >
                {t("settingsPage.agentAccess.copyConfig")}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Collapse>
    </Box>
  );
}

function actionText(state: AgentClientConnectionState, t: ReturnType<typeof useI18n>["t"]) {
  switch (state) {
    case "connected":
      return t("settingsPage.agentAccess.reconnect");
    case "needsUpdate":
      return t("settingsPage.agentAccess.updateConnection");
    case "notConnected":
      return t("settingsPage.agentAccess.connect");
  }
}

function statusText(state: AgentClientConnectionState, t: ReturnType<typeof useI18n>["t"]) {
  switch (state) {
    case "connected":
      return t("settingsPage.agentAccess.clientStatusConnected");
    case "needsUpdate":
      return t("settingsPage.agentAccess.clientStatusNeedsUpdate");
    case "notConnected":
      return t("settingsPage.agentAccess.clientStatusNotConnected");
  }
}

function statusColor(state: AgentClientConnectionState) {
  switch (state) {
    case "connected":
      return "success" as const;
    case "needsUpdate":
      return "warning" as const;
    case "notConnected":
      return "default" as const;
  }
}

function clientMeta(client: AgentClientInfo["client"], t: ReturnType<typeof useI18n>["t"]) {
  switch (client) {
    case "codex":
      return t("settingsPage.agentAccess.clientCodexMeta");
    case "claude":
      return t("settingsPage.agentAccess.clientClaudeMeta");
    case "cursor":
      return t("settingsPage.agentAccess.clientCursorMeta");
  }
}

function clientHint(client: AgentClientInfo["client"], t: ReturnType<typeof useI18n>["t"]) {
  switch (client) {
    case "codex":
      return t("settingsPage.agentAccess.clientCodexHint");
    case "claude":
      return t("settingsPage.agentAccess.clientClaudeHint");
    case "cursor":
      return t("settingsPage.agentAccess.cursorHint");
  }
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

function clientIcon(client: AgentClientInfo["client"]) {
  switch (client) {
    case "codex":
      return <TerminalRoundedIcon fontSize="small" />;
    case "claude":
      return <AutoAwesomeRoundedIcon fontSize="small" />;
    case "cursor":
      return <MouseRoundedIcon fontSize="small" />;
  }
}
