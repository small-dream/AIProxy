import { alpha, type Theme } from "@mui/material/styles";

export function buildContextMenuSlotProps(minWidth: number) {
  return {
    list: {
      dense: true,
      sx: {
        p: "5px",
      },
    },
    paper: {
      elevation: 0,
      sx: (theme: Theme) => ({
        backdropFilter: "blur(22px) saturate(1.35)",
        WebkitBackdropFilter: "blur(22px) saturate(1.35)",
        backgroundClip: "padding-box",
        backgroundImage: "none",
        backgroundColor:
          theme.palette.mode === "dark"
            ? alpha(theme.palette.background.paper, 0.88)
            : alpha(theme.palette.background.paper, 0.92),
        border: "1px solid",
        borderColor:
          theme.palette.mode === "dark"
            ? alpha(theme.palette.common.white, 0.12)
            : alpha(theme.palette.common.black, 0.11),
        borderRadius: "16px",
        boxShadow:
          theme.palette.mode === "dark"
            ? [
                `0 24px 58px ${alpha(theme.palette.common.black, 0.52)}`,
                `0 8px 18px ${alpha(theme.palette.common.black, 0.34)}`,
                `inset 0 1px 0 ${alpha(theme.palette.common.white, 0.08)}`,
              ].join(", ")
            : [
                `0 24px 58px ${alpha(theme.palette.common.black, 0.18)}`,
                `0 8px 18px ${alpha(theme.palette.common.black, 0.1)}`,
                `inset 0 1px 0 ${alpha(theme.palette.common.white, 0.72)}`,
              ].join(", "),
        minWidth,
        mt: 0.5,
        overflow: "hidden",
      }),
    },
  } as const;
}

export function getContextMenuItemSx(theme: Theme) {
  return {
    borderRadius: "9px",
    color: theme.palette.text.primary,
    columnGap: 1,
    minHeight: 30,
    px: 1.125,
    py: 0.5,
    transition: "background-color 120ms ease, color 120ms ease, box-shadow 120ms ease",
    "&:hover": {
      backgroundColor:
        theme.palette.mode === "dark"
          ? alpha(theme.palette.common.white, 0.08)
          : alpha(theme.palette.common.black, 0.055),
    },
    "&.Mui-focusVisible": {
      backgroundColor:
        theme.palette.mode === "dark"
          ? alpha(theme.palette.common.white, 0.1)
          : alpha(theme.palette.common.black, 0.07),
      boxShadow:
        theme.palette.mode === "dark"
          ? `inset 0 0 0 1px ${alpha(theme.palette.common.white, 0.08)}`
          : `inset 0 0 0 1px ${alpha(theme.palette.common.black, 0.04)}`,
    },
    "&:active": {
      backgroundColor:
        theme.palette.mode === "dark"
          ? alpha(theme.palette.common.white, 0.12)
          : alpha(theme.palette.common.black, 0.085),
    },
    "& .MuiTouchRipple-root": {
      display: "none",
    },
  } as const;
}

export function getContextMenuIconSx(theme: Theme) {
  return {
    color: alpha(theme.palette.text.secondary, theme.palette.mode === "dark" ? 0.86 : 0.9),
    justifyContent: "center",
    minWidth: 20,
    width: 20,
    "& .MuiSvgIcon-root": {
      fontSize: 17,
    },
  } as const;
}

export function getContextMenuDividerSx(theme: Theme) {
  return {
    borderColor:
      theme.palette.mode === "dark"
        ? alpha(theme.palette.common.white, 0.08)
        : alpha(theme.palette.common.black, 0.1),
    mx: 3,
    my: 0.5,
  } as const;
}

export const contextMenuItemTextProps = {
  primaryTypographyProps: {
    fontSize: 13,
    fontWeight: 450,
    letterSpacing: 0,
    lineHeight: 1.25,
    noWrap: true,
  },
} as const;
