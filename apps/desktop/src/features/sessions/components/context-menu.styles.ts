import { alpha, type Theme } from "@mui/material/styles";

export function buildContextMenuSlotProps(minWidth: number) {
  return {
    list: {
      dense: true,
      sx: {
        p: 0.5,
      },
    },
    paper: {
      elevation: 0,
      sx: (theme: Theme) => ({
        backdropFilter: "blur(16px)",
        backgroundImage: "none",
        backgroundColor:
          theme.palette.mode === "dark"
            ? alpha(theme.palette.background.paper, 0.96)
            : alpha(theme.palette.background.paper, 0.985),
        border: "1px solid",
        borderColor:
          theme.palette.mode === "dark"
            ? alpha(theme.palette.common.white, 0.08)
            : alpha(theme.palette.common.black, 0.08),
        borderRadius: 2,
        boxShadow:
          theme.palette.mode === "dark"
            ? `0 14px 34px ${alpha(theme.palette.common.black, 0.42)}, 0 2px 8px ${alpha(theme.palette.common.black, 0.28)}`
            : `0 14px 34px ${alpha(theme.palette.common.black, 0.16)}, 0 2px 8px ${alpha(theme.palette.common.black, 0.08)}`,
        minWidth,
        mt: 0.25,
        overflow: "hidden",
      }),
    },
  } as const;
}

export function getContextMenuItemSx(theme: Theme) {
  return {
    borderRadius: 1.25,
    columnGap: 1,
    minHeight: 30,
    px: 1,
    py: 0.5,
    transition: "background-color 120ms ease, color 120ms ease",
    "&:hover": {
      backgroundColor:
        theme.palette.mode === "dark"
          ? alpha(theme.palette.primary.main, 0.18)
          : alpha(theme.palette.primary.main, 0.1),
    },
    "&.Mui-focusVisible": {
      backgroundColor:
        theme.palette.mode === "dark"
          ? alpha(theme.palette.primary.main, 0.2)
          : alpha(theme.palette.primary.main, 0.12),
    },
  } as const;
}

export function getContextMenuIconSx(theme: Theme) {
  return {
    color: theme.palette.text.secondary,
    minWidth: 18,
    "& .MuiSvgIcon-root": {
      fontSize: 16,
    },
  } as const;
}

export function getContextMenuDividerSx(theme: Theme) {
  return {
    borderColor:
      theme.palette.mode === "dark"
        ? alpha(theme.palette.common.white, 0.08)
        : alpha(theme.palette.common.black, 0.08),
    my: 0.5,
  } as const;
}

export const contextMenuItemTextProps = {
  primaryTypographyProps: {
    fontSize: 13,
    fontWeight: 400,
    lineHeight: 1.3,
  },
} as const;
