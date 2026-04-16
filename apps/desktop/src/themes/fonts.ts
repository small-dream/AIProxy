export type FontLocale = "en" | "zh-CN";

const sansFontCandidatesByLocale: Record<FontLocale, readonly string[]> = {
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
};

const sansFontFamiliesByLocale: Record<FontLocale, string> = {
  en: [
    "\"SF Pro Text\"",
    "\"SF Pro Display\"",
    "-apple-system",
    "BlinkMacSystemFont",
    "\"Segoe UI Variable\"",
    "\"Segoe UI\"",
    "Roboto",
    "\"Helvetica Neue\"",
    "Arial",
    "\"PingFang SC\"",
    "\"Hiragino Sans GB\"",
    "\"Microsoft YaHei UI\"",
    "\"Microsoft YaHei\"",
    "\"Noto Sans CJK SC\"",
    "\"Noto Sans\"",
    "sans-serif",
  ].join(", "),
  "zh-CN": [
    "\"PingFang SC\"",
    "\"Hiragino Sans GB\"",
    "\"Microsoft YaHei UI\"",
    "\"Microsoft YaHei\"",
    "\"Noto Sans CJK SC\"",
    "\"Noto Sans SC\"",
    "\"Source Han Sans SC\"",
    "\"SF Pro Text\"",
    "\"SF Pro Display\"",
    "-apple-system",
    "BlinkMacSystemFont",
    "\"Segoe UI Variable\"",
    "\"Segoe UI\"",
    "Roboto",
    "\"Helvetica Neue\"",
    "Arial",
    "\"Noto Sans\"",
    "sans-serif",
  ].join(", "),
};

export const fontFamilies = {
  mono: [
    "ui-monospace",
    "\"SFMono-Regular\"",
    "\"SF Mono\"",
    "Menlo",
    "Monaco",
    "Consolas",
    "\"Liberation Mono\"",
    "\"Courier New\"",
    "monospace",
  ].join(", "),
} as const;

export function getSansFontCandidates(locale: FontLocale): readonly string[] {
  return sansFontCandidatesByLocale[locale];
}

export function getSansFontFamily(locale: FontLocale): string {
  return sansFontFamiliesByLocale[locale];
}
