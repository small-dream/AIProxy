import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  Box,
  InputBase,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n, type TranslationKey } from "@/i18n";
import {
  DEFAULT_SETTINGS_SECTION,
  readSettingsSectionParam,
  SETTINGS_SECTION_IDS,
  type SettingsSectionId,
} from "./settings-navigation";
import { SETTINGS_SEARCH_ENTRIES, type SettingsSearchEntry } from "./settings-search";
import { AboutSection } from "./sections/AboutSection";
import { AiModelSettingsSection } from "./sections/AiModelSettingsSection";
import { AppearanceSettingsSection } from "./sections/AppearanceSettingsSection";
import { BehaviorSettingsSection } from "./sections/BehaviorSettingsSection";
import { ProxySettingsSection } from "./sections/ProxySettingsSection";
import { SslProxyingSection } from "./sections/SslProxyingSection";
import { UpdatesSection } from "./sections/UpdatesSection";
import { UpstreamProxySection } from "./sections/UpstreamProxySection";

type SearchResult = SettingsSearchEntry & {
  label: string;
  description: string;
};

const SECTION_TITLE_KEYS: Record<SettingsSectionId, TranslationKey> = {
  proxy: "settingsNavigation.proxy",
  upstream: "settingsNavigation.upstream",
  ssl: "settingsNavigation.ssl",
  ai: "settingsNavigation.ai",
  appearance: "settingsNavigation.appearance",
  behavior: "settingsNavigation.behavior",
  updates: "settingsNavigation.updates",
  about: "settingsNavigation.about",
};

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

export function SettingsPage() {
  const { t } = useI18n();
  const theme = useTheme();
  const isWideViewport = useMediaQuery(theme.breakpoints.up("md"));
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sectionId = readSettingsSectionParam(searchParams.get("section"));
  const [searchText, setSearchText] = useState("");
  const [activeItemId, setActiveItemId] = useState<string | null>(null);

  const updateSection = useCallback(
    (nextSectionId: SettingsSectionId) => {
      const nextSearchParams = new URLSearchParams(searchParams);
      if (nextSectionId === DEFAULT_SETTINGS_SECTION) {
        nextSearchParams.delete("section");
      } else {
        nextSearchParams.set("section", nextSectionId);
      }
      navigate(
        { pathname: location.pathname, search: nextSearchParams.toString() },
        { replace: true },
      );
      setActiveItemId(null);
    },
    [location.pathname, navigate, searchParams],
  );

  const searchResults = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchText);
    if (normalizedQuery.length === 0) return [];

    return SETTINGS_SEARCH_ENTRIES.map((entry) => {
      const label = t(entry.labelKey);
      const descriptions = entry.descriptionKeys.map((descriptionKey) => t(descriptionKey));
      const haystacks = [
        label,
        ...descriptions,
        ...(entry.keywords ?? []),
        SECTION_TITLE_KEYS[entry.sectionId] ? t(SECTION_TITLE_KEYS[entry.sectionId]) : "",
      ];
      const matches = haystacks.some((value) =>
        normalizeSearchText(value).includes(normalizedQuery),
      );
      return matches
        ? {
            ...entry,
            label,
            description: descriptions[0] ?? "",
          }
        : null;
    }).filter((entry): entry is SearchResult => entry !== null);
  }, [searchText, t]);

  useEffect(() => {
    if (!activeItemId) return;
    const element = document.getElementById(`settings-item-${activeItemId}`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });

    const highlightTimer = window.setTimeout(() => setActiveItemId(null), 1800);
    return () => window.clearTimeout(highlightTimer);
  }, [activeItemId]);

  function handleSearchResultClick(entry: SearchResult) {
    setSearchText("");
    updateSection(entry.sectionId);
    setActiveItemId(entry.id);
  }

  return (
    <Stack direction={{ md: "row", xs: "column" }} spacing={2.5} sx={{ width: "100%" }}>
      <Stack
        spacing={1.5}
        sx={{
          flexShrink: 0,
          width: { md: 248, xs: "100%" },
        }}
      >
        <InputBase
          size="small"
          fullWidth
          placeholder={t("settingsNavigation.searchPlaceholder")}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          startAdornment={
            <InputAdornment position="start">
              <SearchRoundedIcon fontSize="small" />
            </InputAdornment>
          }
          inputProps={{ "aria-label": t("settingsNavigation.searchLabel") }}
          sx={{
            bgcolor: "background.paper",
            borderRadius: 1.5,
            border: "1px solid",
            borderColor: "divider",
            minHeight: 38,
            px: 1.25,
          }}
        />

        {searchText.length > 0 ? (
          <Box>
            {searchResults.length === 0 ? (
              <Typography variant="body2" sx={{ color: "text.secondary", px: 1 }}>
                {t("settingsNavigation.searchNoResults")}
              </Typography>
            ) : (
              <List disablePadding dense>
                {searchResults.map((entry) => (
                  <ListItemButton
                    key={`${entry.sectionId}-${entry.id}`}
                    onClick={() => handleSearchResultClick(entry)}
                    sx={{ borderRadius: 1.5, py: 0.75 }}
                  >
                    <ListItemText
                      primary={entry.label}
                      secondary={
                        <>
                          {t(SECTION_TITLE_KEYS[entry.sectionId])}
                          {entry.description ? ` · ${entry.description}` : ""}
                        </>
                      }
                      slotProps={{
                        primary: { variant: "body2", noWrap: true },
                        secondary: {
                          component: "div",
                          noWrap: true,
                          sx: { display: "block", overflow: "hidden", textOverflow: "ellipsis" },
                        },
                      }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Box>
        ) : (
          <List disablePadding>
            {SETTINGS_SECTION_IDS.map((id) => (
              <ListItemButton
                key={id}
                selected={sectionId === id}
                onClick={() => updateSection(id)}
                sx={{ borderRadius: 1.5, minHeight: 38 }}
              >
                <ListItemText
                  primary={t(SECTION_TITLE_KEYS[id])}
                  slotProps={{ primary: { variant: "body2" } }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </Stack>

      <Stack spacing={2} sx={{ flex: 1, minWidth: 0 }}>
        <Stack spacing={0.25}>
          <Typography variant="h4" sx={{ fontSize: 30, lineHeight: 1.15 }}>
            {isWideViewport ? "Settings" : "Settings"}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("settingsPage.description")}
          </Typography>
        </Stack>

        {sectionId === "proxy" ? <ProxySettingsSection /> : null}
        {sectionId === "upstream" ? <UpstreamProxySection /> : null}
        {sectionId === "ssl" ? <SslProxyingSection /> : null}
        {sectionId === "ai" ? <AiModelSettingsSection /> : null}
        {sectionId === "appearance" ? <AppearanceSettingsSection /> : null}
        {sectionId === "behavior" ? <BehaviorSettingsSection /> : null}
        {sectionId === "updates" ? <UpdatesSection /> : null}
        {sectionId === "about" ? <AboutSection /> : null}
      </Stack>
    </Stack>
  );
}
