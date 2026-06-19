import { Box, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ReactNode } from "react";

export function PaneHeader({
  actions,
  icon,
  meta,
  title,
}: {
  actions?: ReactNode;
  icon: ReactNode;
  meta: string;
  title: string;
}) {
  return (
    <Stack
      direction="row"
      spacing={0.875}
      sx={{ alignItems: "center", flexShrink: 0, minHeight: 54, px: 1.125 }}
    >
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.16 : 0.09),
          borderRadius: 1,
          color: "primary.main",
          display: "flex",
          height: 32,
          justifyContent: "center",
          width: 32,
          "& svg": { fontSize: 18 },
        })}
      >
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 800 }}>
          {title}
        </Typography>
        <Typography
          noWrap
          sx={{
            color: "text.secondary",
            fontSize: 11.25
          }}>
          {meta}
        </Typography>
      </Box>
      {actions}
    </Stack>
  );
}
