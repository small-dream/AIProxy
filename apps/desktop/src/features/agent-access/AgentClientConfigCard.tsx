import AutoFixHighRoundedIcon from "@mui/icons-material/AutoFixHighRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Alert, Box, Button, Chip, Stack, Typography } from "@mui/material";
import { useState } from "react";

import type { AgentClientInfo } from "@aiproxy/shared-types";

import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";

import type { InstallAgentSkillStatus } from "@aiproxy/shared-types";

type AgentClientConfigCardProps = {
  info: AgentClientInfo;
  busy: boolean;
  onCopy: (info: AgentClientInfo) => void;
  onInstallConfig: (info: AgentClientInfo) => void;
  onInstall: (info: AgentClientInfo) => void;
  installStatus?: InstallAgentSkillStatus | undefined;
};

export function AgentClientConfigCard({
  busy,
  info,
  installStatus,
  onCopy,
  onInstallConfig,
  onInstall,
}: AgentClientConfigCardProps) {
  const { t } = useI18n();
  const [manualConfigOpen, setManualConfigOpen] = useState(false);
  const clientLabel = clientName(info.client, t);
  const configPath = info.configPath ?? t("settingsPage.agentAccess.claudeProjectConfigPath");
  const configStatus =
    info.client === "claude"
      ? t("settingsPage.agentAccess.configProjectLevel")
      : info.configInstalled
        ? t("settingsPage.agentAccess.configInstalledLabel")
        : info.configExists
          ? t("settingsPage.agentAccess.configOutdated")
          : t("settingsPage.agentAccess.configMissing");
  const skillStatus = info.skillInstalled
    ? info.skillManaged
      ? t("settingsPage.agentAccess.skillManaged")
      : t("settingsPage.agentAccess.skillCustom")
    : t("settingsPage.agentAccess.skillNotInstalled");

  return (
    <SectionCard
      compact
      title={clientLabel}
      description={t("settingsPage.agentAccess.clientDescription")}
      toolbar={
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Chip
            size="small"
            variant="outlined"
            color={
              info.client === "claude"
                ? "default"
                : info.configInstalled
                  ? "success"
                  : info.configExists
                    ? "warning"
                    : "default"
            }
            label={configStatus}
          />
          <Chip
            size="small"
            variant="outlined"
            color={info.skillInstalled ? (info.skillManaged ? "success" : "warning") : "default"}
            label={skillStatus}
          />
        </Stack>
      }
    >
      <Stack spacing={1.5}>
        {info.client === "cursor" ? (
          <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
            {t("settingsPage.agentAccess.cursorHint")}
          </Alert>
        ) : null}
        {info.client === "claude" ? (
          <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
            {t("settingsPage.agentAccess.claudeHint")}
          </Alert>
        ) : null}

        <Stack spacing={0.5}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("settingsPage.agentAccess.configPath")}
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
            {configPath}
          </Typography>
        </Stack>

        <Stack spacing={0.5}>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("settingsPage.agentAccess.skillPath")}
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
            {info.skillPath}
          </Typography>
        </Stack>

        <Stack direction={{ sm: "row", xs: "column" }} spacing={1} sx={{ pt: 0.5 }}>
          <Button
            size="small"
            variant="contained"
            startIcon={<AutoFixHighRoundedIcon />}
            disabled={busy}
            onClick={() => onInstallConfig(info)}
            sx={{ minHeight: 34 }}
          >
            {t("settingsPage.agentAccess.installConfig")}
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<DownloadRoundedIcon />}
            disabled={busy}
            onClick={() => onInstall(info)}
            sx={{ minHeight: 34 }}
          >
            {installStatus === "installed"
              ? t("settingsPage.agentAccess.skillInstalledAction")
              : installStatus === "upToDate"
                ? t("settingsPage.agentAccess.skillUpToDateAction")
                : t("settingsPage.agentAccess.installSkill")}
          </Button>
        </Stack>

        <Box>
          <Button
            size="small"
            variant="text"
            color="inherit"
            onClick={() => setManualConfigOpen((current) => !current)}
            endIcon={
              <ExpandMoreRoundedIcon
                fontSize="small"
                sx={{
                  transform: manualConfigOpen ? "rotate(180deg)" : "none",
                  transition: "transform 150ms ease",
                }}
              />
            }
            sx={{ color: "text.secondary", minHeight: 32, px: 0.5 }}
          >
            {t("settingsPage.agentAccess.manualConfigToggle")}
          </Button>
          {manualConfigOpen ? (
            <Stack spacing={1} sx={{ mt: 0.5 }}>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {t("settingsPage.agentAccess.manualConfigDescription")}
              </Typography>
              <Box
                component="pre"
                sx={{
                  bgcolor: "action.hover",
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  fontSize: 12,
                  lineHeight: 1.55,
                  m: 0,
                  maxHeight: 220,
                  overflow: "auto",
                  p: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {info.configSnippet}
              </Box>
              <Box>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ContentCopyRoundedIcon />}
                  onClick={() => onCopy(info)}
                  sx={{ minHeight: 32 }}
                >
                  {t("settingsPage.agentAccess.copyConfig")}
                </Button>
              </Box>
            </Stack>
          ) : null}
        </Box>
      </Stack>
    </SectionCard>
  );
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
