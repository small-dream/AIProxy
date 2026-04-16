import { type PropsWithChildren, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@mui/material/styles";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { I18nProvider, resolveLocale, type SupportedLocale } from "@/i18n";
import { logDevInfo } from "@/services/logger/dev-logger";
import { createAppTheme, resolveThemeMode } from "@/themes/app-theme";
import { fontFamilies, getSansFontCandidates, getSansFontFamily } from "@/themes/fonts";

function detectActiveFont(candidates: string[]): string {
  const testText = "mmmmmmmmmmlli";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

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
  const languagePreference = useAppPreferencesStore((state) => state.languagePreference);
  const themePreference = useAppPreferencesStore((state) => state.themePreference);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 10_000,
          },
        },
      }),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => getSystemPrefersDark());
  const [systemLocale, setSystemLocale] = useState<SupportedLocale>(() => getSystemLocale());
  const themeMode = resolveThemeMode(themePreference, systemPrefersDark);
  const locale = languagePreference === "system" ? systemLocale : languagePreference;
  const theme = useMemo(() => createAppTheme(themeMode, locale), [locale, themeMode]);

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
    const configuredFontStack = getSansFontFamily(locale);
    const activeFont = detectActiveFont([...getSansFontCandidates(locale)]);

    logDevInfo("ui.theme", "font_resolved", {
      computedFontFamily,
      configuredMonoFontStack: fontFamilies.mono,
      configuredFontStack,
      locale,
      resolvedFontCandidate: activeFont,
    });
  }, [locale]);

  return (
    <ThemeProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>{children}</I18nProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
