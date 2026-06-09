import { Box, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export function EditorHeader({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  subtitle: string;
  title: string;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ borderBottom: 1, borderColor: "divider", pb: 1 }}
    >
      <Box
        sx={{
          alignItems: "center",
          bgcolor: "action.selected",
          borderRadius: "8px",
          color: "primary.main",
          display: "flex",
          height: 34,
          justifyContent: "center",
          width: 34,
          "& svg": { fontSize: 19 },
        }}
      >
        {icon}
      </Box>
      <Stack sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 750 }} noWrap>
          {title}
        </Typography>
        <Typography color="text.secondary" variant="caption" noWrap>
          {subtitle}
        </Typography>
      </Stack>
    </Stack>
  );
}
