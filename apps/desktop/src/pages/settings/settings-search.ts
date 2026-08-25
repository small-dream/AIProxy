import type { TranslationKey } from "@/i18n";

import type { SettingsSectionId } from "./settings-navigation";

export type SettingsSearchEntry = {
  id: string;
  sectionId: SettingsSectionId;
  labelKey: TranslationKey;
  descriptionKeys: readonly TranslationKey[];
  keywords?: readonly string[];
};

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  {
    id: "proxy-port",
    sectionId: "proxy",
    labelKey: "proxyPresets.proxyPort",
    descriptionKeys: [],
    keywords: ["port", "http", "https", "端口"],
  },
  {
    id: "ssl-enabled",
    sectionId: "proxy",
    labelKey: "proxyPresets.sslEnabled",
    descriptionKeys: [],
    keywords: ["tls", "decrypt", "intercept", "解密", "抓包"],
  },
  {
    id: "http2",
    sectionId: "proxy",
    labelKey: "proxyPresets.http2Enabled",
    descriptionKeys: ["proxyPresets.http2EnabledDescription"],
    keywords: ["protocol", "h2", "协议"],
  },
  {
    id: "upstream-tls-verification",
    sectionId: "proxy",
    labelKey: "proxyPresets.verifyUpstreamTls",
    descriptionKeys: ["proxyPresets.verifyUpstreamTlsDescription"],
    keywords: ["certificate", "ca", "证书", "校验"],
  },
  {
    id: "tls-hosts",
    sectionId: "proxy",
    labelKey: "proxyPresets.tlsVerifyHosts",
    descriptionKeys: [],
    keywords: ["allowlist", "hosts", "域名"],
  },
  {
    id: "upstream-enabled",
    sectionId: "upstream",
    labelKey: "upstreamProxy.enabled",
    descriptionKeys: ["upstreamProxy.enabledDescription"],
    keywords: ["chain", "forward", "链式", "转发"],
  },
  {
    id: "upstream-host",
    sectionId: "upstream",
    labelKey: "upstreamProxy.host",
    descriptionKeys: ["upstreamProxy.hostValidation"],
    keywords: ["address", "server", "地址"],
  },
  {
    id: "upstream-bypass",
    sectionId: "upstream",
    labelKey: "upstreamProxy.bypass",
    descriptionKeys: ["upstreamProxy.bypassDescription"],
    keywords: ["exclude", "direct", "直连", "绕过"],
  },
  {
    id: "ssl-include",
    sectionId: "ssl",
    labelKey: "sslProxying.includeEnabledLabel",
    descriptionKeys: ["sslProxying.includeEnabledDescription"],
    keywords: ["decrypt", "host list", "解密", "域名"],
  },
  {
    id: "ssl-exclude",
    sectionId: "ssl",
    labelKey: "sslProxying.excludeEnabledLabel",
    descriptionKeys: ["sslProxying.excludeEnabledDescription"],
    keywords: ["pinning", "skip", "排除", "证书锁定"],
  },
  {
    id: "ai-provider",
    sectionId: "ai",
    labelKey: "settingsPage.aiProvider",
    descriptionKeys: [],
    keywords: ["openai", "provider", "供应商"],
  },
  {
    id: "ai-model",
    sectionId: "ai",
    labelKey: "settingsPage.aiModel",
    descriptionKeys: [],
    keywords: ["llm", "model", "模型"],
  },
  {
    id: "ai-api-key",
    sectionId: "ai",
    labelKey: "settingsPage.aiApiKey",
    descriptionKeys: [],
    keywords: ["token", "secret", "密钥"],
  },
  {
    id: "language",
    sectionId: "appearance",
    labelKey: "settingsPage.languageLabel",
    descriptionKeys: [],
    keywords: ["english", "locale", "chinese", "语言", "中文"],
  },
  {
    id: "theme",
    sectionId: "appearance",
    labelKey: "settingsPage.themeLabel",
    descriptionKeys: [],
    keywords: ["dark", "light", "theme", "暗色", "浅色"],
  },
  {
    id: "ui-font",
    sectionId: "appearance",
    labelKey: "settingsPage.fontLabel",
    descriptionKeys: [],
    keywords: ["typeface", "ui font", "字体"],
  },
  {
    id: "content-font",
    sectionId: "appearance",
    labelKey: "settingsPage.contentFontLabel",
    descriptionKeys: [],
    keywords: ["code font", "monospace", "等宽"],
  },
  {
    id: "font-size",
    sectionId: "appearance",
    labelKey: "settingsPage.fontSizeLabel",
    descriptionKeys: [],
    keywords: ["text size", "zoom", "字号"],
  },
  {
    id: "clear-confirmations",
    sectionId: "behavior",
    labelKey: "settingsPage.clearSessionsConfirmLabel",
    descriptionKeys: ["settingsPage.clearSessionsConfirmDescription"],
    keywords: ["dangerous action", "sessions", "危险操作", "确认"],
  },
  {
    id: "breakpoint-notifications",
    sectionId: "behavior",
    labelKey: "settingsPage.breakpointNotificationsLabel",
    descriptionKeys: ["settingsPage.breakpointNotificationsDescription"],
    keywords: ["os notification", "system notification", "系统通知", "断点"],
  },
];
