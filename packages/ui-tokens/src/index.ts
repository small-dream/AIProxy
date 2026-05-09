export const colorTokens = {
  light: {
    primary: "#2563EB",
    primaryContainer: "#DBEAFE",
    secondary: "#0F766E",
    background: "#F4F7FB",
    surface: "#FFFFFF",
    surfaceVariant: "#EEF3F8",
    outline: "#D7DEE8",
    textPrimary: "#111827",
    textSecondary: "#5B6678",
    success: "#16803C",
    warning: "#B7791F",
    error: "#C2413B",
    info: "#0369A1",
  },
  dark: {
    primary: "#60A5FA",
    primaryContainer: "#1E3A5F",
    secondary: "#5EEAD4",
    background: "#0D1117",
    surface: "#151B23",
    surfaceVariant: "#1F2937",
    outline: "#334155",
    textPrimary: "#F8FAFC",
    textSecondary: "#A5B4C6",
    success: "#4ADE80",
    warning: "#FBBF24",
    error: "#F87171",
    info: "#38BDF8",
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
  card: 8,
  dialog: 12,
  shell: 10,
} as const;

export type ThemeMode = keyof typeof colorTokens;
