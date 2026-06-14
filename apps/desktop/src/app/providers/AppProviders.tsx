import { type PropsWithChildren, useEffect, useMemo, useState } from "react";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@mui/material/styles";

import { coerceAppError } from "@aiproxy/shared-types";
import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { I18nProvider, resolveLocale, type SupportedLocale } from "@/i18n";
import { logDevInfo } from "@/services/logger/dev-logger";
import { setMenuLocale } from "@/services/commands";
import { useNotificationStore } from "@/services/notification.store";
import { createAppTheme, resolveThemeMode } from "@/themes/app-theme";
import {
  fontFamilies,
  getAppFontCandidates,
  getAppFontFamily,
  getContentFontCandidates,
  getContentFontFamily,
} from "@/themes/fonts";

function detectActiveFont(candidates: string[]): string {
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) {
    return "unknown";
  }

  const testText = "mmmmmmmmmmlli";
  const canvas = document.createElement("canvas");
  let ctx: CanvasRenderingContext2D | null;

  try {
    ctx = canvas.getContext("2d");
  } catch {
    return "unknown";
  }

  if (!ctx) {
    return "unknown";
  }

  const baseFamilies = ["sans-serif", "serif", "monospace"];
  const baseWidths = new Map<string, number>();

  for (const baseFamily of baseFamilies) {
    ctx.font = `72px ${baseFamily}`;
    baseWidths.set(baseFamily, ctx.measureText(testText).width);
  }

  for (const font of candidates) {
    for (const baseFamily of baseFamilies) {
      ctx.font = `72px "${font}", ${baseFamily}`;

      if (ctx.measureText(testText).width !== baseWidths.get(baseFamily)) {
        return font;
      }
    }
  }

  return "sans-serif (fallback)";
}

function getSystemPrefersDark() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getSystemLocale(): SupportedLocale {
  if (typeof navigator === "undefined") {
    return "en";
  }

  return resolveLocale("system", navigator.languages, navigator.language);
}

export function AppProviders({ children }: PropsWithChildren) {
  const contentCustomFontFamily = useAppPreferencesStore((state) => state.contentCustomFontFamily);
  const contentFontPreference = useAppPreferencesStore((state) => state.contentFontPreference);
  const fontFamilyPreference = useAppPreferencesStore((state) => state.fontFamilyPreference);
  const fontSizePreference = useAppPreferencesStore((state) => state.fontSizePreference);
  const languagePreference = useAppPreferencesStore((state) => state.languagePreference);
  const themePreference = useAppPreferencesStore((state) => state.themePreference);
  const uiCustomFontFamily = useAppPreferencesStore((state) => state.uiCustomFontFamily);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 60_000,
          },
        },
        queryCache: new QueryCache({
          onError: (error) => {
            // Skip benign errors that callers handle intentionally
            // (e.g. stale session-detail lookups after the session was cleared).
            if (coerceAppError(error).code === "SESSION_NOT_FOUND") return;

            const message =
              coerceAppError(error).message || "Query failed";
            useNotificationStore.getState().push(message);
          },
        }),
      }),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => getSystemPrefersDark());
  const [systemLocale, setSystemLocale] = useState<SupportedLocale>(() => getSystemLocale());
  const themeMode = resolveThemeMode(themePreference, systemPrefersDark);
  const locale = languagePreference === "system" ? systemLocale : languagePreference;
  const theme = useMemo(
    () =>
      createAppTheme(
        themeMode,
        locale,
        fontFamilyPreference,
        contentFontPreference,
        uiCustomFontFamily,
        contentCustomFontFamily,
        fontSizePreference,
      ),
    [
      contentCustomFontFamily,
      contentFontPreference,
      fontFamilyPreference,
      fontSizePreference,
      locale,
      themeMode,
      uiCustomFontFamily,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
    } else {
      mediaQuery.addListener(handleChange);
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === "function") {
        mediaQuery.removeEventListener("change", handleChange);
      } else {
        mediaQuery.removeListener(handleChange);
      }
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.colorScheme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    function handleLanguageChange() {
      setSystemLocale(getSystemLocale());
    }

    window.addEventListener("languagechange", handleLanguageChange);

    return () => {
      window.removeEventListener("languagechange", handleLanguageChange);
    };
  }, []);

  useEffect(() => {
    const computedFontFamily = window.getComputedStyle(document.body).fontFamily;
    const configuredFontStack = getAppFontFamily(fontFamilyPreference, locale, uiCustomFontFamily);
    const activeFont = detectActiveFont([
      ...getAppFontCandidates(fontFamilyPreference, locale, uiCustomFontFamily),
    ]);
    const configuredContentFontStack = getContentFontFamily(
      contentFontPreference,
      locale,
      fontFamilyPreference,
      uiCustomFontFamily,
      contentCustomFontFamily,
    );
    const activeContentFont = detectActiveFont([
      ...getContentFontCandidates(
        contentFontPreference,
        locale,
        fontFamilyPreference,
        uiCustomFontFamily,
        contentCustomFontFamily,
      ),
    ]);

    logDevInfo("ui.theme", "font_resolved", {
      computedFontFamily,
      configuredContentCustomFontFamily: contentCustomFontFamily,
      configuredContentFontPreference: contentFontPreference,
      configuredContentFontStack,
      configuredCustomFontFamily: uiCustomFontFamily,
      configuredFontPreference: fontFamilyPreference,
      configuredMonoFontStack: fontFamilies.mono,
      configuredFontStack,
      configuredFontSize: fontSizePreference,
      locale,
      resolvedContentFontCandidate: activeContentFont,
      resolvedFontCandidate: activeFont,
    });
  }, [
    contentCustomFontFamily,
    contentFontPreference,
    fontFamilyPreference,
    fontSizePreference,
    locale,
    uiCustomFontFamily,
  ]);

  // Keep the native (macOS) menu in sync with the display language. Depends on both
  // the preference (en/system/zh-CN switches) and the resolved locale (so a system
  // language change while preference is "system" also re-syncs). Fire-and-forget;
  // setMenuLocale never rejects.
  useEffect(() => {
    void setMenuLocale(languagePreference);
  }, [languagePreference, locale]);

  return (
    <ThemeProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>{children}</I18nProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
