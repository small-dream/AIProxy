import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { Box, ButtonBase, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";

import { useI18n } from "@/i18n";

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

export function SessionContainerTabs({
  containers,
  onAddContainer,
  onCloseContainer,
  onSelectContainer,
}: SessionContainerTabsProps) {
  const { t } = useI18n();

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
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
          minHeight: 36,
          px: 0.5,
          py: 0.25,
        }}
      >
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            flex: 1,
            minWidth: 0,
            overflowX: "auto",
          }}
        >
          {containers.map((container) => (
            <ButtonBase
              key={container.id}
              onClick={() => onSelectContainer(container.id)}
              sx={(theme) => ({
                alignItems: "center",
                borderBottom: "2px solid",
                borderColor: container.isActive ? theme.palette.primary.main : "transparent",
                borderRadius: 0,
                color: container.isActive ? "text.primary" : "text.secondary",
                cursor: "pointer",
                display: "inline-flex",
                flex: "0 0 auto",
                height: 28,
                justifyContent: "center",
                minWidth: 0,
                px: 0.75,
                transition: "border-color 140ms ease, color 140ms ease",
                "&:hover": {
                  color: "text.primary",
                },
              })}
            >
              <Typography
                noWrap
                sx={{
                  fontSize: 12.5,
                  fontWeight: container.isActive ? 700 : 500,
                  lineHeight: 1,
                }}
              >
                {t("sessionsPage.containers.sessionTitle", { index: container.labelNumber })}
              </Typography>
            </ButtonBase>
          ))}
        </Stack>

        <Box
          sx={{
            alignSelf: "stretch",
            borderLeft: 1,
            borderColor: "divider",
            flex: "0 0 auto",
          }}
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
                  height: 24,
                  width: 24,
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
                height: 24,
                width: 24,
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
