import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { Box, ButtonBase, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";

import { memo } from "react";

import { useI18n } from "@/i18n";
import { getWorkbenchFontSize } from "./SessionInspectorShared";

type SessionContainerTabItem = {
  id: string;
  isActive: boolean;
  labelNumber: number;
};

type SessionContainerTabsProps = {
  containers: SessionContainerTabItem[];
  onAddContainer: () => void;
  onCloseContainer: (containerId: string) => void;
  onSelectContainer: (containerId: string) => void;
};

function SessionContainerTabsImpl({
  containers,
  onAddContainer,
  onCloseContainer,
  onSelectContainer,
}: SessionContainerTabsProps) {
  const { t } = useI18n();

  return (
    <Box
      sx={{
        bgcolor: (theme) => theme.palette.mode === "dark"
          ? alpha(theme.palette.background.default, 0.28)
          : alpha(theme.palette.background.default, 0.62),
        borderBottom: 1,
        borderColor: "divider",
        minWidth: 0,
      }}
    >
      <Stack
        alignItems="center"
        direction="row"
        justifyContent="space-between"
        spacing={1}
        sx={{
          minHeight: 42,
          px: 0.75,
          py: 0.5,
        }}
      >
        <Stack
          alignItems="center"
          direction="row"
          spacing={0.5}
          sx={{
            flex: 1,
            height: 30,
            minWidth: 0,
            overscrollBehaviorX: "contain",
            overflowX: "auto",
            overflowY: "hidden",
            scrollbarWidth: "none",
            WebkitOverflowScrolling: "touch",
            "&::-webkit-scrollbar": {
              display: "none",
            },
          }}
        >
          {containers.map((container) => (
            <ButtonBase
              key={container.id}
              onClick={() => onSelectContainer(container.id)}
              sx={(theme) => ({
                alignItems: "center",
                bgcolor: container.isActive
                  ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.10)
                  : "transparent",
                border: "1px solid",
                borderColor: container.isActive
                  ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.38 : 0.22)
                  : "transparent",
                borderRadius: 1.25,
                color: container.isActive ? "text.primary" : "text.secondary",
                cursor: "pointer",
                display: "inline-flex",
                flex: "0 0 auto",
                height: 30,
                justifyContent: "center",
                minWidth: 0,
                px: 1.1,
                transition: "background-color 140ms ease, border-color 140ms ease, color 140ms ease",
                "&:hover": {
                  bgcolor: container.isActive
                    ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.22 : 0.13)
                    : alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05),
                  color: "text.primary",
                },
              })}
            >
              <Typography
                noWrap
                sx={(theme) => ({
                  fontSize: getWorkbenchFontSize(theme, 13),
                  fontWeight: container.isActive ? 600 : 500,
                  lineHeight: 1,
                })}
              >
                {t("sessionsPage.containers.sessionTitle", { index: container.labelNumber })}
              </Typography>
            </ButtonBase>
          ))}
        </Stack>

        <Box
          sx={(theme) => ({
            alignSelf: "stretch",
            borderLeft: 1,
            borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.46 : 0.62),
            flex: "0 0 auto",
          })}
        />

        <Stack direction="row" spacing={0.25} sx={{ flex: "0 0 auto" }}>
          {containers.length > 1 ? (
            <Tooltip arrow title={t("sessionsPage.containers.close")}>
              <IconButton
                aria-label={t("sessionsPage.containers.close")}
                onClick={() => {
                  const activeContainer = containers.find((container) => container.isActive);

                  if (activeContainer) {
                    onCloseContainer(activeContainer.id);
                  }
                }}
                size="small"
                sx={{
                  borderRadius: 0.75,
                  color: "text.secondary",
                  height: 28,
                  width: 28,
                  "&:hover": {
                    bgcolor: (theme) => alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05),
                    color: "text.primary",
                  },
                }}
              >
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}

          <Tooltip arrow title={t("sessionsPage.containers.add")}>
            <IconButton
              aria-label={t("sessionsPage.containers.add")}
              onClick={onAddContainer}
              size="small"
              sx={{
                borderRadius: 0.75,
                color: "text.secondary",
                height: 28,
                width: 28,
                "&:hover": {
                  bgcolor: (theme) => alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05),
                  color: "text.primary",
                },
              }}
            >
              <AddRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
    </Box>
  );
}

export const SessionContainerTabs = memo(SessionContainerTabsImpl);
