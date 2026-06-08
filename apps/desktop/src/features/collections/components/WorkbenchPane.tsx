import { Box } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { alpha } from "@mui/material/styles";
import type { ReactNode } from "react";

export function WorkbenchPane({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) {
  const paneSx = [
    (theme: Theme) => ({
      bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.78 : 0.96),
      border: 1,
      borderColor: "divider",
      borderRadius: 1.25,
      boxShadow: "none",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
      overflow: "hidden",
    }),
    ...(sx ? (Array.isArray(sx) ? sx : [sx]) : []),
  ] as SxProps<Theme>;

  return <Box sx={paneSx}>{children}</Box>;
}
