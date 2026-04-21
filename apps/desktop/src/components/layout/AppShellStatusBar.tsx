import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import PauseCircleRoundedIcon from "@mui/icons-material/PauseCircleRounded";
import SettingsEthernetRoundedIcon from "@mui/icons-material/SettingsEthernetRounded";
import { Box, ButtonBase, Divider, Stack, Tooltip, Typography } from "@mui/material";
import type { CertificateStatus, ProxyStatus } from "@aiproxy/shared-types";
import type { ReactNode } from "react";

import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

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
    <Typography
      color="text.disabled"
      sx={{ flexShrink: 0, fontFamily: fontFamilies.mono, fontSize: 12, px: 0.25, userSelect: "none" }}
    >
      |
    </Typography>
  );
}

function StatusItem({ active = true, icon, label, monospaced = false, onClick, title }: StatusItemProps) {
  const content = (
    <Stack
      alignItems="center"
      direction="row"
      spacing={0.625}
      sx={{
        color: active ? "text.primary" : "text.secondary",
        minHeight: 24,
        minWidth: 0,
        px: 0.875,
        py: 0.25,
        whiteSpace: "nowrap",
      }}
    >
      {icon ? (
        <Box
          sx={{
            alignItems: "center",
            color: active ? "inherit" : "text.disabled",
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
        sx={{
          fontFamily: monospaced ? fontFamilies.mono : "inherit",
          fontSize: 12.5,
          fontWeight: onClick ? 600 : 500,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
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
        borderRadius: 1,
        display: "block",
        flexShrink: 0,
        textAlign: "left",
        transition: "background-color 140ms ease, color 140ms ease",
        "&:hover": {
          bgcolor: "action.selected",
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
  const sslLabel = proxyStatus?.sslEnabled
    ? t("appShell.sslOn")
    : certificateStatus?.trusted
      ? t("appShell.sslReady")
      : t("appShell.sslSetup");

  return (
    <>
      <Divider />

      <Stack
        alignItems="center"
        direction="row"
        spacing={0.25}
        sx={{
          bgcolor: "background.paper",
          minHeight: 32,
          overflowX: "auto",
          px: 1,
          py: 0.375,
          scrollbarWidth: "thin",
          whiteSpace: "nowrap",
        }}
      >
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
          label={proxyStatus?.systemProxyEnabled ? t("appShell.systemProxyOn") : t("appShell.systemProxyOff")}
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
          active={Boolean(proxyStatus?.sslEnabled || certificateStatus?.trusted)}
          icon={<LockRoundedIcon />}
          label={sslLabel}
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
