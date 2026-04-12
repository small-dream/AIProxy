import { alpha, createTheme } from "@mui/material/styles";
import { colorTokens, radiusTokens } from "@pharles/ui-tokens";

export const appTheme = createTheme({
  shape: {
    borderRadius: radiusTokens.control,
  },
  palette: {
    mode: "light",
    primary: {
      main: colorTokens.light.primary,
    },
    secondary: {
      main: colorTokens.light.secondary,
    },
    background: {
      default: colorTokens.light.background,
      paper: colorTokens.light.surface,
    },
    divider: colorTokens.light.outline,
    action: {
      hover: colorTokens.light.surfaceVariant,
      selected: alpha(colorTokens.light.primary, 0.08),
      focus: alpha(colorTokens.light.primary, 0.12),
      disabledBackground: colorTokens.light.surfaceVariant,
    },
    success: {
      main: colorTokens.light.success,
    },
    warning: {
      main: colorTokens.light.warning,
    },
    error: {
      main: colorTokens.light.error,
    },
    info: {
      main: colorTokens.light.info,
    },
    text: {
      primary: colorTokens.light.textPrimary,
      secondary: colorTokens.light.textSecondary,
    },
  },
  typography: {
    fontFamily: "Inter, Segoe UI, SF Pro, sans-serif",
    button: {
      fontWeight: 600,
      textTransform: "none",
    },
  },
  components: {
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: alpha(colorTokens.light.surface, 0.92),
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: radiusTokens.card,
        },
        outlined: {
          backgroundColor: colorTokens.light.surface,
          borderRadius: radiusTokens.card,
          boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: radiusTokens.card,
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: {
          borderColor: colorTokens.light.outline,
          opacity: 0.7,
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          fontSize: 12,
          fontWeight: 500,
          minHeight: 32,
          minWidth: 0,
          padding: "6px 10px",
          textTransform: "none",
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: {
          minHeight: 32,
        },
        indicator: {
          height: 2,
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          '&.Mui-selected': {
            backgroundColor: alpha(colorTokens.light.primary, 0.08),
          },
          '&.Mui-selected:hover': {
            backgroundColor: alpha(colorTokens.light.primary, 0.12),
          },
        },
      },
    },
  },
});
