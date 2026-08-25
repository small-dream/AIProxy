import { Box, Divider, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export const compactAlertSx = {
  alignItems: "center",
  borderRadius: 1.5,
  px: 1.5,
  py: 0.75,
  "& .MuiAlert-icon": {
    fontSize: 20,
    mr: 1.25,
    py: 0,
  },
  "& .MuiAlert-message": {
    fontSize: 13,
    lineHeight: 1.45,
    py: 0,
  },
};

export const rowControlSx = {
  flexShrink: 0,
  width: { sm: 320, xs: "100%" },
};

export const selectControlSx = {
  ...rowControlSx,
  "& .MuiInputBase-root": { minHeight: 36 },
};

export const compactFieldSx = {
  "& .MuiInputBase-root": { minHeight: 36 },
};

export function SettingsRow({
  label,
  description,
  hint,
  itemId,
  stacked = false,
  children,
}: {
  label: string;
  description?: string;
  hint?: ReactNode;
  itemId?: string;
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      id={itemId}
      data-settings-item={itemId}
      sx={{
        display: "flex",
        flexDirection: { xs: "column", sm: stacked ? "column" : "row" },
        alignItems: { xs: "stretch", sm: stacked ? "stretch" : "flex-start" },
        justifyContent: "space-between",
        gap: { xs: 1, sm: 3 },
        scrollMarginTop: 24,
        py: 1.5,
        transition: (theme) => theme.transitions.create("background-color"),
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1, pt: { sm: stacked ? 0 : 0.25 } }}>
        <Typography variant="body2" sx={{ fontWeight: 500, lineHeight: 1.45 }}>
          {label}
        </Typography>
        {description ? (
          <Typography
            variant="caption"
            sx={{ display: "block", color: "text.secondary", lineHeight: 1.5, mt: 0.25 }}
          >
            {description}
          </Typography>
        ) : null}
        {hint}
      </Box>
      {children}
    </Box>
  );
}

export function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <Stack spacing={0} divider={<Divider />}>
      {children}
    </Stack>
  );
}

export function SettingsFooter({ hint, children }: { hint?: ReactNode; children: ReactNode }) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: { xs: "column", sm: "row" },
        alignItems: { xs: "stretch", sm: "center" },
        justifyContent: "space-between",
        gap: 1.5,
        py: 1.5,
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>{hint}</Box>
      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        {children}
      </Stack>
    </Box>
  );
}
