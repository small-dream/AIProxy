export type FontLocale = "en" | "zh-CN";

export const appFontPreferences = [
  "system",
  "pingfang",
  "noto-sans-sc",
  "source-han-sans",
  "serif",
  "custom",
] as const;
export type AppFontPreference = (typeof appFontPreferences)[number];

export const contentFontPreferences = [
  "follow-ui",
  "system-mono",
  "system",
  "pingfang",
  "noto-sans-sc",
  "source-han-sans",
  "serif",
  "custom",
] as const;
export type ContentFontPreference = (typeof contentFontPreferences)[number];

type BuiltInFontPreference = Exclude<AppFontPreference, "custom">;

export const defaultAppFontSize = 13;
export const minAppFontSize = 12;
export const maxAppFontSize = 18;
export const appFontSizeOptions = [12, 13, 14, 15, 16, 18] as const;
export const appFontCssVars = {
  content: "var(--aiproxy-content-font-family)",
} as const;

const builtInFontCandidates: Record<
  BuiltInFontPreference,
  Record<FontLocale, readonly string[]>
> = {
  system: {
    en: [
      "SF Pro Text",
      "SF Pro Display",
      "Segoe UI Variable",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
      "PingFang SC",
      "Hiragino Sans GB",
      "Microsoft YaHei UI",
      "Microsoft YaHei",
      "Noto Sans CJK SC",
      "Noto Sans",
    ],
    "zh-CN": [
      "PingFang SC",
      "Hiragino Sans GB",
      "Microsoft YaHei UI",
      "Microsoft YaHei",
      "Noto Sans CJK SC",
      "Noto Sans SC",
      "Source Han Sans SC",
      "SF Pro Text",
      "SF Pro Display",
      "Segoe UI Variable",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
      "Noto Sans",
    ],
  },
  pingfang: {
    en: [
      "PingFang SC",
      "Hiragino Sans GB",
      "Microsoft YaHei UI",
      "Microsoft YaHei",
      "SF Pro Text",
      "SF Pro Display",
      "Segoe UI Variable",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
      "Noto Sans",
    ],
    "zh-CN": [
      "PingFang SC",
      "Hiragino Sans GB",
      "Microsoft YaHei UI",
      "Microsoft YaHei",
      "Noto Sans CJK SC",
      "Noto Sans SC",
      "Source Han Sans SC",
      "SF Pro Text",
      "SF Pro Display",
      "Segoe UI Variable",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
      "Noto Sans",
    ],
  },
  "noto-sans-sc": {
    en: [
      "Noto Sans CJK SC",
      "Noto Sans SC",
      "Noto Sans",
      "Source Han Sans SC",
      "SF Pro Text",
      "SF Pro Display",
      "Segoe UI Variable",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
      "PingFang SC",
      "Hiragino Sans GB",
      "Microsoft YaHei UI",
      "Microsoft YaHei",
    ],
    "zh-CN": [
      "Noto Sans CJK SC",
      "Noto Sans SC",
      "Noto Sans",
      "Source Han Sans SC",
      "PingFang SC",
      "Hiragino Sans GB",
      "Microsoft YaHei UI",
      "Microsoft YaHei",
      "SF Pro Text",
      "SF Pro Display",
      "Segoe UI Variable",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
    ],
  },
  "source-han-sans": {
    en: [
      "Source Han Sans SC",
      "Noto Sans CJK SC",
      "Noto Sans SC",
      "Noto Sans",
      "PingFang SC",
      "Hiragino Sans GB",
      "Microsoft YaHei UI",
      "Microsoft YaHei",
      "SF Pro Text",
      "SF Pro Display",
      "Segoe UI Variable",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
    ],
    "zh-CN": [
      "Source Han Sans SC",
      "Noto Sans CJK SC",
      "Noto Sans SC",
      "Noto Sans",
      "PingFang SC",
      "Hiragino Sans GB",
      "Microsoft YaHei UI",
      "Microsoft YaHei",
      "SF Pro Text",
      "SF Pro Display",
      "Segoe UI Variable",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
    ],
  },
  serif: {
    en: [
      "Georgia",
      "Charter",
      "Cambria",
      "Times New Roman",
      "Songti SC",
      "STSong",
      "Noto Serif CJK SC",
      "Noto Serif SC",
      "Source Han Serif SC",
      "SimSun",
    ],
    "zh-CN": [
      "Songti SC",
      "STSong",
      "Noto Serif CJK SC",
      "Noto Serif SC",
      "Source Han Serif SC",
      "SimSun",
      "Georgia",
      "Charter",
      "Cambria",
      "Times New Roman",
    ],
  },
};

const builtInFontFamilies: Record<BuiltInFontPreference, Record<FontLocale, string>> = {
  system: {
    en: [
      "-apple-system",
      "BlinkMacSystemFont",
      '"SF Pro Text"',
      '"SF Pro Display"',
      '"Segoe UI Variable"',
      '"Segoe UI"',
      "Roboto",
      '"Helvetica Neue"',
      "Arial",
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      '"Noto Sans CJK SC"',
      '"Noto Sans"',
      "sans-serif",
    ].join(", "),
    "zh-CN": [
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      '"Noto Sans CJK SC"',
      '"Noto Sans SC"',
      '"Source Han Sans SC"',
      '"SF Pro Text"',
      '"SF Pro Display"',
      "-apple-system",
      "BlinkMacSystemFont",
      '"Segoe UI Variable"',
      '"Segoe UI"',
      "Roboto",
      '"Helvetica Neue"',
      "Arial",
      '"Noto Sans"',
      "sans-serif",
    ].join(", "),
  },
  pingfang: {
    en: [
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      '"SF Pro Text"',
      '"SF Pro Display"',
      "-apple-system",
      "BlinkMacSystemFont",
      '"Segoe UI Variable"',
      '"Segoe UI"',
      "Roboto",
      '"Helvetica Neue"',
      "Arial",
      '"Noto Sans"',
      "sans-serif",
    ].join(", "),
    "zh-CN": [
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      '"Noto Sans CJK SC"',
      '"Noto Sans SC"',
      '"Source Han Sans SC"',
      '"SF Pro Text"',
      '"SF Pro Display"',
      "-apple-system",
      "BlinkMacSystemFont",
      '"Segoe UI Variable"',
      '"Segoe UI"',
      "Roboto",
      '"Helvetica Neue"',
      "Arial",
      '"Noto Sans"',
      "sans-serif",
    ].join(", "),
  },
  "noto-sans-sc": {
    en: [
      '"Noto Sans CJK SC"',
      '"Noto Sans SC"',
      '"Noto Sans"',
      '"Source Han Sans SC"',
      '"SF Pro Text"',
      '"SF Pro Display"',
      "-apple-system",
      "BlinkMacSystemFont",
      '"Segoe UI Variable"',
      '"Segoe UI"',
      "Roboto",
      '"Helvetica Neue"',
      "Arial",
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      "sans-serif",
    ].join(", "),
    "zh-CN": [
      '"Noto Sans CJK SC"',
      '"Noto Sans SC"',
      '"Noto Sans"',
      '"Source Han Sans SC"',
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      '"SF Pro Text"',
      '"SF Pro Display"',
      "-apple-system",
      "BlinkMacSystemFont",
      '"Segoe UI Variable"',
      '"Segoe UI"',
      "Roboto",
      '"Helvetica Neue"',
      "Arial",
      "sans-serif",
    ].join(", "),
  },
  "source-han-sans": {
    en: [
      '"Source Han Sans SC"',
      '"Noto Sans CJK SC"',
      '"Noto Sans SC"',
      '"Noto Sans"',
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      '"SF Pro Text"',
      '"SF Pro Display"',
      "-apple-system",
      "BlinkMacSystemFont",
      '"Segoe UI Variable"',
      '"Segoe UI"',
      "Roboto",
      '"Helvetica Neue"',
      "Arial",
      "sans-serif",
    ].join(", "),
    "zh-CN": [
      '"Source Han Sans SC"',
      '"Noto Sans CJK SC"',
      '"Noto Sans SC"',
      '"Noto Sans"',
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Microsoft YaHei UI"',
      '"Microsoft YaHei"',
      '"SF Pro Text"',
      '"SF Pro Display"',
      "-apple-system",
      "BlinkMacSystemFont",
      '"Segoe UI Variable"',
      '"Segoe UI"',
      "Roboto",
      '"Helvetica Neue"',
      "Arial",
      "sans-serif",
    ].join(", "),
  },
  serif: {
    en: [
      "Georgia",
      "Charter",
      "Cambria",
      '"Times New Roman"',
      '"Songti SC"',
      "STSong",
      '"Noto Serif CJK SC"',
      '"Noto Serif SC"',
      '"Source Han Serif SC"',
      "SimSun",
      "serif",
    ].join(", "),
    "zh-CN": [
      '"Songti SC"',
      "STSong",
      '"Noto Serif CJK SC"',
      '"Noto Serif SC"',
      '"Source Han Serif SC"',
      "SimSun",
      "Georgia",
      "Charter",
      "Cambria",
      '"Times New Roman"',
      "serif",
    ].join(", "),
  },
};

export const fontFamilies = {
  mono: [
    "ui-monospace",
    '"SFMono-Regular"',
    '"SF Mono"',
    "Menlo",
    "Monaco",
    "Consolas",
    '"Liberation Mono"',
    '"Courier New"',
    "monospace",
  ].join(", "),
} as const;

const monoFontCandidates = [
  "SFMono-Regular",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Liberation Mono",
  "Courier New",
] as const;

export function clampAppFontSize(value: number): number {
  return Math.min(maxAppFontSize, Math.max(minAppFontSize, Math.round(value)));
}

function formatFontFamilyToken(fontName: string): string {
  const trimmed = fontName.trim();

  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed;
  }

  return /[\s,]/.test(trimmed) ? `"${trimmed}"` : trimmed;
}

function getCustomFontCandidates(
  customFontFamily: string,
  fallbackPreference: BuiltInFontPreference,
  locale: FontLocale,
) {
  const trimmed = customFontFamily.trim();

  if (!trimmed) {
    return builtInFontCandidates[fallbackPreference][locale];
  }

  return [trimmed, ...builtInFontCandidates[fallbackPreference][locale]];
}

function getCustomFontFamily(
  customFontFamily: string,
  fallbackPreference: BuiltInFontPreference,
  locale: FontLocale,
) {
  const fallbackFontFamily = builtInFontFamilies[fallbackPreference][locale];
  const customToken = formatFontFamilyToken(customFontFamily);

  return customToken ? `${customToken}, ${fallbackFontFamily}` : fallbackFontFamily;
}

export function getAppFontCandidates(
  preference: AppFontPreference,
  locale: FontLocale,
  customFontFamily = "",
): readonly string[] {
  if (preference === "custom") {
    return getCustomFontCandidates(customFontFamily, "system", locale);
  }

  return builtInFontCandidates[preference][locale];
}

export function getAppFontFamily(
  preference: AppFontPreference,
  locale: FontLocale,
  customFontFamily = "",
): string {
  if (preference === "custom") {
    return getCustomFontFamily(customFontFamily, "system", locale);
  }

  return builtInFontFamilies[preference][locale];
}

export function getContentFontCandidates(
  preference: ContentFontPreference,
  locale: FontLocale,
  uiPreference: AppFontPreference,
  uiCustomFontFamily = "",
  contentCustomFontFamily = "",
): readonly string[] {
  if (preference === "follow-ui") {
    return getAppFontCandidates(uiPreference, locale, uiCustomFontFamily);
  }

  if (preference === "system-mono") {
    return monoFontCandidates;
  }

  if (preference === "custom") {
    return getCustomFontCandidates(contentCustomFontFamily, "system", locale);
  }

  return builtInFontCandidates[preference][locale];
}

export function getContentFontFamily(
  preference: ContentFontPreference,
  locale: FontLocale,
  uiPreference: AppFontPreference,
  uiCustomFontFamily = "",
  contentCustomFontFamily = "",
): string {
  if (preference === "follow-ui") {
    return getAppFontFamily(uiPreference, locale, uiCustomFontFamily);
  }

  if (preference === "system-mono") {
    return fontFamilies.mono;
  }

  if (preference === "custom") {
    return getCustomFontFamily(contentCustomFontFamily, "system", locale);
  }

  return builtInFontFamilies[preference][locale];
}
