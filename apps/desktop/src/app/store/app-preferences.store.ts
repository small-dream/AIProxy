import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type LanguagePreference = "en" | "system" | "zh-CN";
export type ThemePreference = "dark" | "light" | "system";

type AppPreferencesState = {
  languagePreference: LanguagePreference;
  themePreference: ThemePreference;
  setLanguagePreference: (preference: LanguagePreference) => void;
  setThemePreference: (preference: ThemePreference) => void;
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
      languagePreference: "system",
      themePreference: "system",
      setLanguagePreference: (languagePreference) => set({ languagePreference }),
      setThemePreference: (themePreference) => set({ themePreference }),
    }),
    {
      name: "aiproxy.app-preferences",
      storage: createJSONStorage(getSafeStorage),
    },
  ),
);
