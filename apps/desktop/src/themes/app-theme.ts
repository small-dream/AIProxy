import { createTheme } from "@mui/material/styles";
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
});
