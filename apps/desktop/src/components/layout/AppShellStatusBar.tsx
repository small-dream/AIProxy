import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import PauseCircleRoundedIcon from "@mui/icons-material/PauseCircleRounded";
import SettingsEthernetRoundedIcon from "@mui/icons-material/SettingsEthernetRounded";
import { Box, ButtonBase, Divider, Stack, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { CertificateStatus, ProxyStatus } from "@aiproxy/shared-types";
import type { ReactNode } from "react";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { computeSetupProgress } from "@/features/certificate-center/setup-progress.helpers";
import { useI18n } from "@/i18n";
import { defaultAppFontSize, fontFamilies } from "@/themes/fonts";

type StatusItemProps = {
  active?: boolean;
  icon?: ReactNode;
  label: string;
  monospaced?: boolean;
  onClick?: () => void;
  title?: string;
};

type AppShellStatusBarProps = {
  certificateStatus: CertificateStatus | undefined;
  locale: string;
  onCertificatesClick: () => void;
  onPortClick: () => void;
  onRulesClick: () => void;
  onSystemProxyToggle: () => void;
  pendingBreakpointCount: number;
  port: number;
  proxyStatus: ProxyStatus | undefined;
};

function StatusSeparator() {
  return (
    <Box
      sx={{
        alignSelf: "center",
        bgcolor: "divider",
        flexShrink: 0,
        height: 16,
        opacity: 0.8,
        width: "1px",
      }}
    />
  );
}

function StatusItem({
  active = true,
  icon,
  label,
  monospaced = false,
  onClick,
  title,
}: StatusItemProps) {
  const getStatusFontSize = (themeFontSize: number) =>
    `${(themeFontSize / defaultAppFontSize) * 12}px`;
  const content = (
    <Stack
      direction="row"
      spacing={0.625}
      sx={{
        alignItems: "center",
        color: active ? "text.primary" : "text.secondary",
        borderRadius: 999,
        minHeight: 24,
        minWidth: 0,
        px: 0.875,
        py: 0.25,
        whiteSpace: "nowrap"
      }}>
      {icon ? (
        <Box
          sx={{
            alignItems: "center",
            color: active ? "primary.main" : "text.disabled",
            display: "flex",
            flexShrink: 0,
            "& > svg": {
              fontSize: 14,
            },
          }}
        >
          {icon}
        </Box>
      ) : null}
      <Typography
        sx={(theme) => ({
          fontFamily: monospaced ? fontFamilies.mono : "inherit",
          fontSize: getStatusFontSize(theme.typography.fontSize),
          fontWeight: 500,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        })}
      >
        {label}
      </Typography>
    </Stack>
  );

  if (!onClick) {
    return content;
  }

  const interactiveNode = (
    <ButtonBase
      onClick={onClick}
      sx={{
        borderRadius: 999,
        display: "block",
        flexShrink: 0,
        textAlign: "left",
        transition: "background-color 140ms ease, color 140ms ease",
        "&:hover": {
          bgcolor: "action.hover",
        },
        "&:focus-visible": {
          outline: "2px solid",
          outlineColor: "primary.main",
          outlineOffset: 1,
        },
      }}
    >
      {content}
    </ButtonBase>
  );

  return title ? (
    <Tooltip arrow title={title}>
      {interactiveNode}
    </Tooltip>
  ) : (
    interactiveNode
  );
}

export function AppShellStatusBar({
  certificateStatus,
  locale,
  onCertificatesClick,
  onPortClick,
  onRulesClick,
  onSystemProxyToggle,
  pendingBreakpointCount,
  port,
  proxyStatus,
}: AppShellStatusBarProps) {
  const { t } = useI18n();
  // Use the same state model as the checklist/wizard so the cert chip stays in
  // lockstep — including SSL decryption and the manual-proxy acknowledgement,
  // which the previous inline logic ignored.
  const manualProxyAcknowledgedFor = useAppPreferencesStore(
    (state) => state.manualProxyAcknowledgedFor,
  );
  const setupProgress = computeSetupProgress(
    certificateStatus,
    proxyStatus,
    manualProxyAcknowledgedFor,
  );
  const certStageLabel = !setupProgress.certGenerated
    ? t("appShell.certStage.notInstalled")
    : !setupProgress.certTrusted
      ? t("appShell.certStage.installedNotTrusted")
      : !setupProgress.proxyRunning
        ? t("appShell.certStage.trustedProxyDown")
        : !setupProgress.sslEnabled
          ? t("appShell.certStage.trustedEnableSsl")
          : !setupProgress.proxySatisfied
            ? t("appShell.certStage.trustedNoRouting")
            : t("appShell.certStage.ready");
  const captureReady = setupProgress.captureReady;

  return (
    <>
      <Divider />
      <Stack
        direction="row"
        spacing={0.5}
        sx={[{
          alignItems: "center"
        }, (theme) => ({
          bgcolor:
            theme.palette.mode === "dark"
              ? alpha(theme.palette.background.paper, 0.82)
              : alpha(theme.palette.background.paper, 0.92),
          minHeight: 32,
          overflowX: "auto",
          px: 1.25,
          py: 0.375,
          scrollbarWidth: "thin",
          whiteSpace: "nowrap",
        })]}>
        <StatusItem
          active={proxyStatus?.running ?? false}
          icon={<FiberManualRecordRoundedIcon />}
          label={proxyStatus?.running ? t("common.states.recording") : t("common.states.idle")}
        />

        <StatusSeparator />

        <StatusItem
          icon={<SettingsEthernetRoundedIcon />}
          label={t("appShell.portStatus", { port })}
          monospaced
          onClick={onPortClick}
          title={t("appShell.changePortTitle")}
        />

        <StatusSeparator />

        <StatusItem
          active={proxyStatus?.systemProxyEnabled ?? false}
          icon={<LanguageRoundedIcon />}
          label={
            proxyStatus?.systemProxyEnabled
              ? t("appShell.systemProxyOn")
              : t("appShell.systemProxyOff")
          }
          onClick={onSystemProxyToggle}
          title={
            proxyStatus?.systemProxyEnabled
              ? t("appShell.statusDisableSystemProxy")
              : proxyStatus?.running
                ? t("appShell.statusEnableSystemProxy")
                : t("appShell.startProxyBeforeSystemProxy")
          }
        />

        <StatusSeparator />

        <StatusItem
          active={captureReady}
          icon={<LockRoundedIcon />}
          label={certStageLabel}
          onClick={onCertificatesClick}
          title={t("appShell.openCertificatesPage")}
        />

        {pendingBreakpointCount > 0 && (
          <>
            <StatusSeparator />
            <StatusItem
              active
              icon={<PauseCircleRoundedIcon />}
              label={t("appShell.breakpointsPending", {
                count: pendingBreakpointCount,
                suffix: locale === "en" && pendingBreakpointCount > 1 ? "s" : "",
              })}
              onClick={onRulesClick}
              title={t("appShell.breakpointsPendingTitle")}
            />
          </>
        )}
      </Stack>
    </>
  );
}
