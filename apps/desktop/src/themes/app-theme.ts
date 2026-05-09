import { alpha, createTheme, type PaletteMode } from "@mui/material/styles";
import { colorTokens, radiusTokens } from "@aiproxy/ui-tokens";

import type { ThemePreference } from "@/app/store/app-preferences.store";
import {
  getAppFontFamily,
  type AppFontPreference,
  getContentFontFamily,
  type ContentFontPreference,
  type FontLocale,
} from "@/themes/fonts";

export function resolveThemeMode(preference: ThemePreference, systemPrefersDark: boolean | undefined): PaletteMode {
  if (preference === "light" || preference === "dark") {
    return preference;
  }

  return systemPrefersDark ? "dark" : "light";
}

export function getSurfaceShadow(mode: PaletteMode) {
  return mode === "dark"
    ? "0 14px 40px rgba(0, 0, 0, 0.28)"
    : "0 10px 30px rgba(15, 23, 42, 0.06)";
}

export function getHoverShadow(mode: PaletteMode) {
  return mode === "dark"
    ? "0 10px 26px rgba(0, 0, 0, 0.32)"
    : "0 8px 20px rgba(15, 23, 42, 0.08)";
}

export function getSyntaxColors(mode: PaletteMode) {
  return mode === "dark"
    ? {
        boolean: "#569CD6",
        key: "#9CDCFE",
        null: "#569CD6",
        number: "#B5CEA8",
        property: "#9CDCFE",
        string: "#CE9178",
        type: "#4EC9B0",
        value: "#CE9178",
      }
    : {
        boolean: "#0000FF",
        key: "#0451A5",
        null: "#0000FF",
        number: "#098658",
        property: "#0451A5",
        string: "#A31515",
        type: "#6F42C1",
        value: "#A31515",
      };
}

export function createAppTheme(
  mode: PaletteMode,
  locale: FontLocale,
  fontPreference: AppFontPreference,
  contentFontPreference: ContentFontPreference,
  uiCustomFontFamily: string,
  contentCustomFontFamily: string,
  fontSize: number,
) {
  const colors = colorTokens[mode];
  const fontFamily = getAppFontFamily(fontPreference, locale, uiCustomFontFamily);
  const contentFontFamily = getContentFontFamily(
    contentFontPreference,
    locale,
    fontPreference,
    uiCustomFontFamily,
    contentCustomFontFamily,
  );

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
      fontFamily,
      fontSize,
      fontWeightBold: 600,
      fontWeightMedium: 500,
      fontWeightRegular: 400,
      body1: {
        letterSpacing: 0,
        lineHeight: 1.42,
      },
      body2: {
        letterSpacing: 0,
        lineHeight: 1.42,
      },
      button: {
        fontWeight: 500,
        letterSpacing: 0,
        textTransform: "none",
      },
      caption: {
        letterSpacing: 0,
        lineHeight: 1.35,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ":root": {
            "--aiproxy-content-font-family": contentFontFamily,
            "--aiproxy-ui-font-family": fontFamily,
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
            fontFamily,
            fontSynthesis: "none",
            textRendering: "auto",
            WebkitFontSmoothing: "antialiased",
          },
          "*": {
            scrollbarColor: `${alpha(colors.textSecondary, mode === "dark" ? 0.42 : 0.32)} transparent`,
            scrollbarWidth: "thin",
          },
          "*::-webkit-scrollbar": {
            height: 10,
            width: 10,
          },
          "*::-webkit-scrollbar-thumb": {
            backgroundClip: "padding-box",
            backgroundColor: alpha(colors.textSecondary, mode === "dark" ? 0.42 : 0.28),
            border: "3px solid transparent",
            borderRadius: 999,
          },
          "*::-webkit-scrollbar-thumb:hover": {
            backgroundColor: alpha(colors.textSecondary, mode === "dark" ? 0.58 : 0.42),
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
            borderColor: alpha(colors.outline, mode === "dark" ? 0.72 : 0.88),
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
            letterSpacing: 0,
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
            borderRadius: 999,
            height: 2,
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: 999,
            fontWeight: 500,
            letterSpacing: 0,
          },
          sizeSmall: {
            height: 24,
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: radiusTokens.control,
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
