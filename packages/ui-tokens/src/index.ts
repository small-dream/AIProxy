export const colorTokens = {
  light: {
    primary: "#2962FF",
    primaryContainer: "#D6E4FF",
    secondary: "#00BFA5",
    background: "#F7F9FC",
    surface: "#FFFFFF",
    surfaceVariant: "#EEF2F7",
    outline: "#C4CAD4",
    textPrimary: "#17202A",
    textSecondary: "#556070",
    success: "#2E7D32",
    warning: "#ED6C02",
    error: "#D32F2F",
    info: "#0288D1",
  },
  dark: {
    primary: "#2962FF",
    primaryContainer: "#1C336F",
    secondary: "#00BFA5",
    background: "#121212",
    surface: "#1B1F24",
    surfaceVariant: "#232A33",
    outline: "#4A5563",
    textPrimary: "#F5F7FA",
    textSecondary: "#AAB4C0",
    success: "#66BB6A",
    warning: "#FFB74D",
    error: "#EF5350",
    info: "#4FC3F7",
  },
} as const;

export const spacingTokens = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radiusTokens = {
  control: 8,
  card: 12,
  dialog: 16,
  shell: 16,
} as const;

export type ThemeMode = keyof typeof colorTokens;

