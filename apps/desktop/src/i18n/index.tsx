import { createContext, type PropsWithChildren, useContext, useEffect, useState } from "react";

import { useAppPreferencesStore, type LanguagePreference } from "@/app/store/app-preferences.store";

import { enMessages, type Messages } from "./messages/en";
import { zhCNMessages } from "./messages/zh-CN";

export type SupportedLocale = "en" | "zh-CN";
export type TranslationParams = Record<string, number | string>;
type TranslationValue = string | readonly string[];

type MessageLeaf = TranslationValue;
type MessageTree = {
  [key: string]: MessageLeaf | MessageTree;
};

type DotPath<T> = T extends MessageLeaf
  ? never
  : {
      [K in keyof T & string]: T[K] extends MessageLeaf ? K : `${K}.${DotPath<T[K]>}`;
    }[keyof T & string];

export type TranslationKey = DotPath<Messages>;

type I18nContextValue = {
  locale: SupportedLocale;
  preference: LanguagePreference;
  setPreference: (preference: LanguagePreference) => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
  tList: (key: TranslationKey) => readonly string[];
};

const messagesByLocale: Record<SupportedLocale, Messages> = {
  en: enMessages,
  "zh-CN": zhCNMessages,
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function resolveLocale(
  preference: LanguagePreference,
  languages: readonly string[] | undefined,
  fallbackLanguage?: string | undefined,
): SupportedLocale {
  if (preference === "en" || preference === "zh-CN") {
    return preference;
  }

  const candidates = [...(languages ?? []), fallbackLanguage].filter(
    (value): value is string => Boolean(value && value.trim()),
  );

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase();

    if (normalizedCandidate === "zh-cn" || normalizedCandidate.startsWith("zh")) {
      return "zh-CN";
    }

    if (normalizedCandidate === "en" || normalizedCandidate.startsWith("en-")) {
      return "en";
    }
  }

  return "en";
}

function getSystemLocale() {
  if (typeof navigator === "undefined") {
    return "en" as SupportedLocale;
  }

  return resolveLocale("system", navigator.languages, navigator.language);
}

function getMessage(messages: Messages, key: TranslationKey): TranslationValue {
  const value = key.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, messages);

  if (typeof value !== "string" && !Array.isArray(value)) {
    throw new Error(`Missing translation for key "${key}"`);
  }

  return value;
}

function formatMessage(template: string, params?: TranslationParams) {
  if (!params) {
    return template;
  }

  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, token: string) => {
    const value = params[token];
    return value == null ? "" : String(value);
  });
}

export function I18nProvider({ children }: PropsWithChildren) {
  const preference = useAppPreferencesStore((state) => state.languagePreference);
  const setPreference = useAppPreferencesStore((state) => state.setLanguagePreference);
  const [systemLocale, setSystemLocale] = useState<SupportedLocale>(() => getSystemLocale());

  useEffect(() => {
    function handleLanguageChange() {
      setSystemLocale(getSystemLocale());
    }

    window.addEventListener("languagechange", handleLanguageChange);

    return () => {
      window.removeEventListener("languagechange", handleLanguageChange);
    };
  }, []);

  const locale = preference === "system" ? systemLocale : preference;
  const messages = messagesByLocale[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value: I18nContextValue = {
    locale,
    preference,
    setPreference,
    t: (key, params) => {
      const value = getMessage(messages, key);

      if (typeof value !== "string") {
        throw new Error(`Translation key "${key}" does not resolve to a string`);
      }

      return formatMessage(value, params);
    },
    tList: (key) => {
      const value = getMessage(messages, key);

      if (!Array.isArray(value)) {
        throw new Error(`Translation key "${key}" does not resolve to a string list`);
      }

      return value;
    },
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);

  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }

  return context;
}
