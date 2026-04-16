import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  clampAppFontSize,
  defaultAppFontSize,
  type AppFontPreference,
  type ContentFontPreference,
} from "@/themes/fonts";

export type LanguagePreference = "en" | "system" | "zh-CN";
export type ThemePreference = "dark" | "light" | "system";

type AppPreferencesState = {
  contentCustomFontFamily: string;
  contentFontPreference: ContentFontPreference;
  fontFamilyPreference: AppFontPreference;
  fontSizePreference: number;
  uiCustomFontFamily: string;
  languagePreference: LanguagePreference;
  themePreference: ThemePreference;
  setContentCustomFontFamily: (fontFamily: string) => void;
  setContentFontPreference: (preference: ContentFontPreference) => void;
  setFontFamilyPreference: (preference: AppFontPreference) => void;
  setFontSizePreference: (fontSize: number) => void;
  setLanguagePreference: (preference: LanguagePreference) => void;
  setThemePreference: (preference: ThemePreference) => void;
  setUiCustomFontFamily: (fontFamily: string) => void;
};

const fallbackStorage = {
  getItem: () => null,
  removeItem: () => undefined,
  setItem: () => undefined,
};

function getSafeStorage() {
  if (typeof window === "undefined") {
    return fallbackStorage;
  }

  const storage = window.localStorage;

  if (
    typeof storage?.getItem !== "function" ||
    typeof storage?.setItem !== "function" ||
    typeof storage?.removeItem !== "function"
  ) {
    return fallbackStorage;
  }

  return storage;
}

export const useAppPreferencesStore = create<AppPreferencesState>()(
  persist(
    (set) => ({
      contentCustomFontFamily: "",
      contentFontPreference: "system-mono",
      fontFamilyPreference: "system",
      fontSizePreference: defaultAppFontSize,
      languagePreference: "system",
      themePreference: "system",
      uiCustomFontFamily: "",
      setContentCustomFontFamily: (contentCustomFontFamily) => set({ contentCustomFontFamily }),
      setContentFontPreference: (contentFontPreference) => set({ contentFontPreference }),
      setFontFamilyPreference: (fontFamilyPreference) => set({ fontFamilyPreference }),
      setFontSizePreference: (fontSizePreference) =>
        set({ fontSizePreference: clampAppFontSize(fontSizePreference) }),
      setLanguagePreference: (languagePreference) => set({ languagePreference }),
      setThemePreference: (themePreference) => set({ themePreference }),
      setUiCustomFontFamily: (uiCustomFontFamily) => set({ uiCustomFontFamily }),
    }),
    {
      name: "aiproxy.app-preferences",
      storage: createJSONStorage(getSafeStorage),
    },
  ),
);
