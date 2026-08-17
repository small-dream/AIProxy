import { alpha, type Theme } from "@mui/material/styles";

export function buildContextMenuSlotProps(minWidth: number) {
  return {
    list: {
      dense: true,
      sx: {
        p: "4px",
      },
    },
    paper: {
      elevation: 0,
      sx: (theme: Theme) => ({
        backdropFilter: "blur(24px) saturate(1.4)",
        WebkitBackdropFilter: "blur(24px) saturate(1.4)",
        backgroundClip: "padding-box",
        backgroundImage: "none",
        backgroundColor:
          theme.palette.mode === "dark"
            ? alpha(theme.palette.background.paper, 0.82)
            : alpha(theme.palette.background.paper, 0.9),
        border: "1px solid",
        borderColor:
          theme.palette.mode === "dark"
            ? alpha(theme.palette.common.white, 0.1)
            : alpha(theme.palette.common.black, 0.09),
        borderRadius: "10px",
        boxShadow:
          theme.palette.mode === "dark"
            ? [
                `0 1px 2px ${alpha(theme.palette.common.black, 0.5)}`,
                `0 12px 32px ${alpha(theme.palette.common.black, 0.42)}`,
                `0 24px 64px ${alpha(theme.palette.common.black, 0.36)}`,
                `inset 0 1px 0 ${alpha(theme.palette.common.white, 0.07)}`,
              ].join(", ")
            : [
                `0 1px 2px ${alpha(theme.palette.common.black, 0.05)}`,
                `0 8px 24px ${alpha(theme.palette.common.black, 0.1)}`,
                `0 20px 48px ${alpha(theme.palette.common.black, 0.08)}`,
                `inset 0 1px 0 ${alpha(theme.palette.common.white, 0.75)}`,
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
    borderRadius: "6px",
    color: theme.palette.text.primary,
    columnGap: 1.25,
    minHeight: 28,
    px: 1.25,
    py: 0.25,
    transition:
      "background-color 110ms cubic-bezier(0.2, 0, 0, 1), color 110ms cubic-bezier(0.2, 0, 0, 1)",
    "&:hover": {
      backgroundColor:
        theme.palette.mode === "dark"
          ? alpha(theme.palette.common.white, 0.09)
          : alpha(theme.palette.common.black, 0.06),
    },
    "&.Mui-focusVisible": {
      backgroundColor:
        theme.palette.mode === "dark"
          ? alpha(theme.palette.common.white, 0.11)
          : alpha(theme.palette.common.black, 0.075),
      boxShadow:
        theme.palette.mode === "dark"
          ? `inset 0 0 0 1px ${alpha(theme.palette.common.white, 0.08)}`
          : `inset 0 0 0 1px ${alpha(theme.palette.common.black, 0.04)}`,
    },
    "&:active": {
      backgroundColor:
        theme.palette.mode === "dark"
          ? alpha(theme.palette.common.white, 0.13)
          : alpha(theme.palette.common.black, 0.09),
    },
    "&.Mui-disabled": {
      color: theme.palette.action.disabled,
      opacity: 1,
      "& .MuiListItemIcon-root": {
        color: theme.palette.action.disabled,
      },
    },
    "& .MuiTouchRipple-root": {
      display: "none",
    },
  } as const;
}

export function getContextMenuIconSx(theme: Theme) {
  return {
    alignSelf: "center",
    color: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.78 : 0.72),
    justifyContent: "center",
    minWidth: 20,
    width: 20,
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
    mx: 1.25,
    my: 0.5,
  } as const;
}

export const contextMenuItemTextProps = {
  primaryTypographyProps: {
    fontSize: 13,
    fontWeight: 450,
    letterSpacing: 0,
    lineHeight: 1.3,
    noWrap: true,
  },
} as const;
