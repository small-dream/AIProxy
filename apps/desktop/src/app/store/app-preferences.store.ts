import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  clampAppFontSize,
  defaultAppFontSize,
  type AppFontPreference,
  type ContentFontPreference,
} from "@/themes/fonts";
import type { ManualProxyAck } from "@/features/certificate-center/setup-progress.helpers";

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
  // Dangerous-action confirm opt-out. Only Clear All Sessions may skip its
  // confirm dialog (sessions are re-capturable data). See UI_GUIDELINES §11.4.
  skipClearSessionsConfirm: boolean;
  // First-run setup wizard state. See features/certificate-center/setup-progress.helpers.ts
  // for the derived state machine; these three values are the only persisted bits.
  setupWizardCompleted: boolean;
  setupWizardDismissedAt: string | undefined;
  manualProxyAcknowledgedFor: ManualProxyAck | undefined;
  setContentCustomFontFamily: (fontFamily: string) => void;
  setContentFontPreference: (preference: ContentFontPreference) => void;
  setFontFamilyPreference: (preference: AppFontPreference) => void;
  setFontSizePreference: (fontSize: number) => void;
  setLanguagePreference: (preference: LanguagePreference) => void;
  setSkipClearSessionsConfirm: (skip: boolean) => void;
  setThemePreference: (preference: ThemePreference) => void;
  setUiCustomFontFamily: (fontFamily: string) => void;
  markSetupWizardCompleted: () => void;
  dismissSetupWizard: (dismissedAt: string) => void;
  acknowledgeManualProxy: (ack: ManualProxyAck) => void;
  resetSetupWizardState: () => void;
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
      skipClearSessionsConfirm: false,
      setupWizardCompleted: false,
      setupWizardDismissedAt: undefined,
      manualProxyAcknowledgedFor: undefined,
      uiCustomFontFamily: "",
      setContentCustomFontFamily: (contentCustomFontFamily) => set({ contentCustomFontFamily }),
      setContentFontPreference: (contentFontPreference) => set({ contentFontPreference }),
      setFontFamilyPreference: (fontFamilyPreference) => set({ fontFamilyPreference }),
      setFontSizePreference: (fontSizePreference) =>
        set({ fontSizePreference: clampAppFontSize(fontSizePreference) }),
      setLanguagePreference: (languagePreference) => set({ languagePreference }),
      setSkipClearSessionsConfirm: (skipClearSessionsConfirm) => set({ skipClearSessionsConfirm }),
      setThemePreference: (themePreference) => set({ themePreference }),
      setUiCustomFontFamily: (uiCustomFontFamily) => set({ uiCustomFontFamily }),
      markSetupWizardCompleted: () => set({ setupWizardCompleted: true }),
      dismissSetupWizard: (setupWizardDismissedAt) => set({ setupWizardDismissedAt }),
      acknowledgeManualProxy: (manualProxyAcknowledgedFor) => set({ manualProxyAcknowledgedFor }),
      resetSetupWizardState: () =>
        set({
          setupWizardCompleted: false,
          setupWizardDismissedAt: undefined,
          manualProxyAcknowledgedFor: undefined,
        }),
    }),
    {
      name: "aiproxy.app-preferences",
      storage: createJSONStorage(getSafeStorage),
    },
  ),
);
