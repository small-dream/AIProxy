import { alpha, createTheme, type PaletteMode } from "@mui/material/styles";
import { colorTokens, radiusTokens } from "@aiproxy/ui-tokens";

import type { ThemePreference } from "@/app/store/app-preferences.store";

export function resolveThemeMode(preference: ThemePreference, systemPrefersDark: boolean | undefined): PaletteMode {
  if (preference === "light" || preference === "dark") {
    return preference;
  }

  return systemPrefersDark ? "dark" : "light";
}

export function getSurfaceShadow(mode: PaletteMode) {
  return mode === "dark" ? "0 10px 30px rgba(0, 0, 0, 0.22)" : "0 1px 2px rgba(15, 23, 42, 0.04)";
}

export function getHoverShadow(mode: PaletteMode) {
  return mode === "dark" ? "0 14px 34px rgba(0, 0, 0, 0.3)" : "0 1px 3px rgba(0, 0, 0, 0.08)";
}

export function getSyntaxColors(mode: PaletteMode) {
  return mode === "dark"
    ? {
        boolean: "#82AAFF",
        key: "#F78C6C",
        null: "#82AAFF",
        number: "#C3E88D",
        property: "#FFCB6B",
        string: "#C3E88D",
        type: "#C792EA",
        value: "#F07178",
      }
    : {
        boolean: "#0000FF",
        key: "#A31515",
        null: "#0000FF",
        number: "#098658",
        property: "#795E26",
        string: "#0451A5",
        type: "#6F42C1",
        value: "#A31515",
      };
}

export function createAppTheme(mode: PaletteMode) {
  const colors = colorTokens[mode];

  return createTheme({
    shape: {
      borderRadius: radiusTokens.control,
    },
    palette: {
      mode,
      primary: {
        main: colors.primary,
      },
      secondary: {
        main: colors.secondary,
      },
      background: {
        default: colors.background,
        paper: colors.surface,
      },
      divider: alpha(colors.outline, mode === "dark" ? 0.7 : 1),
      action: {
        hover: alpha(colors.textPrimary, mode === "dark" ? 0.06 : 0.04),
        selected: alpha(colors.primary, mode === "dark" ? 0.18 : 0.08),
        focus: alpha(colors.primary, mode === "dark" ? 0.24 : 0.12),
        disabledBackground: alpha(colors.textPrimary, mode === "dark" ? 0.12 : 0.04),
      },
      success: {
        main: colors.success,
      },
      warning: {
        main: colors.warning,
      },
      error: {
        main: colors.error,
      },
      info: {
        main: colors.info,
      },
      text: {
        primary: colors.textPrimary,
        secondary: colors.textSecondary,
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
      MuiCssBaseline: {
        styleOverrides: {
          ":root": {
            colorScheme: mode,
          },
          "*, *::before, *::after": {
            boxSizing: "border-box",
          },
          "html, body, #root": {
            backgroundColor: colors.background,
            minHeight: "100%",
          },
          body: {
            color: colors.textPrimary,
          },
          "::selection": {
            backgroundColor: alpha(colors.primary, mode === "dark" ? 0.34 : 0.2),
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundColor: alpha(colors.surface, mode === "dark" ? 0.86 : 0.92),
            backgroundImage: "none",
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: "none",
            borderRadius: radiusTokens.card,
          },
          outlined: {
            backgroundColor: colors.surface,
            borderColor: alpha(colors.outline, mode === "dark" ? 0.55 : 1),
            borderRadius: radiusTokens.card,
            boxShadow: getSurfaceShadow(mode),
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            backgroundImage: "none",
            borderRadius: radiusTokens.card,
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            backgroundImage: "none",
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundImage: "none",
          },
        },
      },
      MuiDivider: {
        styleOverrides: {
          root: {
            borderColor: alpha(colors.outline, mode === "dark" ? 0.55 : 0.7),
            opacity: 1,
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
              backgroundColor: alpha(colors.primary, mode === "dark" ? 0.18 : 0.08),
            },
            '&.Mui-selected:hover': {
              backgroundColor: alpha(colors.primary, mode === "dark" ? 0.24 : 0.12),
            },
          },
        },
      },
    },
  });
}
