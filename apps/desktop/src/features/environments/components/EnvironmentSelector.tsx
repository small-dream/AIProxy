import BoltRoundedIcon from "@mui/icons-material/BoltRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import {
  Alert,
  Box,
  Divider,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ApiEnvironment } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";

/**
 * Shared active-environment picker (C1). `compact` renders a slim inline
 * control (select + manage button, no label) for the Compose toolbar.
 */
export function EnvironmentSelector(props: {
  activeEnvironmentId: string | null;
  compact?: boolean;
  environments: ApiEnvironment[];
  hasEnvError: boolean;
  onEnvironmentChange: (environmentId: string | null) => void;
  onManageEnvironments: () => void;
}) {
  const { t } = useI18n();
  const {
    activeEnvironmentId,
    compact = false,
    environments,
    hasEnvError,
    onEnvironmentChange,
    onManageEnvironments,
  } = props;

  // Compact mode renders a single 36px-high bordered control (borderless select
  // + manage button) so it shares the Compose toolbar's control vocabulary and
  // can shrink instead of overflowing onto neighboring buttons.
  if (compact) {
    return (
      <Box sx={{ flex: "0 1 auto", minWidth: 0 }}>
        <Stack
          direction="row"
          sx={{
            alignItems: "stretch",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            height: 36,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <Select
            size="small"
            value={activeEnvironmentId ?? ""}
            onChange={(e) => onEnvironmentChange(e.target.value || null)}
            displayEmpty
            sx={{
              color: "text.secondary",
              flex: "1 1 auto",
              fontSize: 12,
              fontWeight: 600,
              minWidth: 0,
              "& .MuiSelect-select": {
                alignItems: "center",
                boxSizing: "border-box",
                display: "flex",
                height: 34,
                minWidth: 0,
                overflow: "hidden",
                pl: 1.25,
                pr: 3,
                py: 0,
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
              "& .MuiOutlinedInput-notchedOutline": { border: 0 },
            }}
          >
            <MenuItem value="">
              <em>{t("environment.noEnvironment")}</em>
            </MenuItem>
            {environments.map((env) => (
              <MenuItem key={env.id} value={env.id}>
                {env.name}
              </MenuItem>
            ))}
          </Select>
          <Divider flexItem orientation="vertical" sx={{ my: 0.75 }} />
          <Tooltip title={t("environment.manage")}>
            <IconButton
              size="small"
              onClick={onManageEnvironments}
              sx={{
                borderRadius: 0,
                color: "text.secondary",
                flex: "0 0 auto",
                width: 34,
                "&:hover": { color: "primary.main" },
              }}
            >
              <SettingsRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        {hasEnvError && (
          <Alert severity="warning" sx={{ mt: 0.5, py: 0 }}>
            {t("common.errors.generic")}
          </Alert>
        )}
      </Box>
    );
  }

  return (
    <Box>
      <Stack
        direction="row"
        spacing={0.75}
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.1 : 0.06),
          border: 1,
          borderColor: alpha(
            theme.palette.primary.main,
            theme.palette.mode === "dark" ? 0.22 : 0.16,
          ),
          borderRadius: 1,
          p: 0.75,
        })}
      >
        <BoltRoundedIcon sx={{ color: "primary.main", flex: "0 0 auto", fontSize: 18 }} />
        <Typography noWrap sx={{ flex: 1, fontSize: 12, fontWeight: 700, minWidth: 0 }}>
          {t("environment.selector")}
        </Typography>
        <Select
          size="small"
          value={activeEnvironmentId ?? ""}
          onChange={(e) => onEnvironmentChange(e.target.value || null)}
          sx={{
            bgcolor: "background.paper",
            flex: "0 0 132px",
            fontSize: 12,
            "& .MuiSelect-select": { py: 0.75 },
          }}
        >
          <MenuItem value="">
            <em>{t("environment.noEnvironment")}</em>
          </MenuItem>
          {environments.map((env) => (
            <MenuItem key={env.id} value={env.id}>
              {env.name}
            </MenuItem>
          ))}
        </Select>
        <Tooltip title={t("environment.manage")}>
          <IconButton
            size="small"
            onClick={onManageEnvironments}
            sx={{ color: "text.secondary", flex: "0 0 auto" }}
          >
            <SettingsRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      {hasEnvError && (
        <Alert severity="warning" sx={{ mt: 0.5, py: 0 }}>
          {t("common.errors.generic")}
        </Alert>
      )}
    </Box>
  );
}
