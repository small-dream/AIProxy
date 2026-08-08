import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import {
  Box,
  Button,
  Divider,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { HeaderEntry } from "@aiproxy/shared-types";
import { useEffect, useRef, useState } from "react";

import type { BodyType, RawLanguage } from "@/features/compose/types";
import { RAW_LANGUAGES } from "@/features/compose/compose-editor.store";
import {
  inspectorPaneActionButtonSx,
  inspectorTabsSx,
} from "@/features/sessions/components/SessionInspectorShared";
import { useI18n, type TranslationKey } from "@/i18n";
import { appFontCssVars } from "@/themes/fonts";
import { EditableKeyValueTable } from "./EditableKeyValueTable";

const BODY_TYPE_KEYS: Record<BodyType, TranslationKey> = {
  none: "composePage.bodyTypes.none",
  formdata: "composePage.bodyTypes.formdata",
  urlencoded: "composePage.bodyTypes.urlencoded",
  raw: "composePage.bodyTypes.raw",
};

type ComposeRequestSectionProps = {
  activeTab: "headers" | "body" | "query";
  body: string;
  bodyType: BodyType;
  chromeless?: boolean;
  formDataEntries: HeaderEntry[];
  headers: HeaderEntry[];
  onActiveTabChange: (tab: "headers" | "body" | "query") => void;
  onBodyChange: (body: string) => void;
  onBodyTypeChange: (bodyType: BodyType) => void;
  onFormDataEntriesChange: (entries: HeaderEntry[]) => void;
  onHeadersChange: (entries: HeaderEntry[]) => void;
  onRequestCollapsedChange?: (collapsed: boolean) => void;
  onRawLanguageChange: (rawLanguage: RawLanguage) => void;
  onUrlChange: (url: string) => void;
  onUrlEncodedEntriesChange: (entries: HeaderEntry[]) => void;
  rawLanguage: RawLanguage;
  requestCollapsed?: boolean;
  url: string;
  urlEncodedEntries: HeaderEntry[];
};

export function ComposeRequestSection({
  activeTab,
  body,
  bodyType,
  chromeless = false,
  formDataEntries,
  headers,
  onActiveTabChange,
  onBodyChange,
  onBodyTypeChange,
  onFormDataEntriesChange,
  onHeadersChange,
  onRequestCollapsedChange,
  onRawLanguageChange,
  onUrlChange,
  onUrlEncodedEntriesChange,
  rawLanguage,
  requestCollapsed = false,
  url,
  urlEncodedEntries,
}: ComposeRequestSectionProps) {
  const { t } = useI18n();

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: chromeless ? 0 : 1,
        borderColor: chromeless ? "transparent" : "divider",
        borderRadius: chromeless ? 0 : 1,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(
            theme.palette.background.paper,
            theme.palette.mode === "dark" ? 0.72 : 0.9,
          ),
          display: "flex",
          minHeight: 42,
          pr: 0.75,
        })}
      >
        <Tabs
          onChange={(_, value) => onActiveTabChange(value)}
          sx={inspectorTabsSx}
          value={activeTab}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab label={t("composePage.tabs.headers")} value="headers" />
          <Tab label={t("composePage.tabs.body")} value="body" />
          <Tab label={t("composePage.tabs.query")} value="query" />
        </Tabs>
        {onRequestCollapsedChange ? (
          <Button
            onClick={() => onRequestCollapsedChange(!requestCollapsed)}
            size="small"
            startIcon={requestCollapsed ? <ExpandMoreRoundedIcon /> : <ExpandLessRoundedIcon />}
            sx={inspectorPaneActionButtonSx}
            variant="text"
          >
            {requestCollapsed ? t("common.actions.expand") : t("common.actions.collapse")}
          </Button>
        ) : null}
      </Box>
      <Divider />
      {requestCollapsed ? null : (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pl: 2, pr: 0.5, pb: 2, pt: 1.5 }}>
          {activeTab === "headers" && (
            <EditableKeyValueTable
              items={headers}
              namePlaceholder={t("common.placeholders.headerName")}
              onChange={onHeadersChange}
              valuePlaceholder={t("common.placeholders.headerValue")}
            />
          )}

          {activeTab === "body" && (
            <Stack spacing={1.25}>
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: "center", flexWrap: "wrap", rowGap: 1 }}
              >
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  sx={(theme) => ({
                    bgcolor: alpha(
                      theme.palette.text.primary,
                      theme.palette.mode === "dark" ? 0.05 : 0.035,
                    ),
                    borderRadius: 1,
                    gap: 0.25,
                    p: 0.25,
                    "& .MuiToggleButton-root": {
                      border: 0,
                      borderRadius: 0.75,
                      color: "text.secondary",
                      fontSize: 12,
                      fontWeight: 600,
                      letterSpacing: 0,
                      minHeight: 28,
                      px: 1.25,
                      textTransform: "none",
                      whiteSpace: "nowrap",
                      "&.Mui-selected": {
                        bgcolor: "background.paper",
                        color: "primary.main",
                        boxShadow:
                          theme.palette.mode === "dark"
                            ? "0 1px 8px rgba(0,0,0,0.24)"
                            : "0 1px 8px rgba(15,23,42,0.08)",
                      },
                    },
                  })}
                  value={bodyType}
                  onChange={(_, value: BodyType | null) => {
                    if (value) {
                      onBodyTypeChange(value);
                    }
                  }}
                >
                  {(["none", "formdata", "urlencoded", "raw"] as const).map((type) => (
                    <ToggleButton key={type} value={type}>
                      {t(BODY_TYPE_KEYS[type])}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
                {bodyType === "raw" && (
                  <Select
                    size="small"
                    sx={{
                      height: 30,
                      fontFamily: appFontCssVars.content,
                      fontSize: 12,
                      fontWeight: 600,
                      "& .MuiSelect-select": { py: 0.5, pr: 3 },
                    }}
                    value={rawLanguage}
                    onChange={(event) => onRawLanguageChange(event.target.value as RawLanguage)}
                  >
                    {RAW_LANGUAGES.map((lang) => (
                      <MenuItem
                        key={lang.value}
                        sx={{ fontFamily: appFontCssVars.content, fontSize: 11 }}
                        value={lang.value}
                      >
                        {t(lang.labelKey)}
                      </MenuItem>
                    ))}
                  </Select>
                )}
              </Stack>

              <Divider />

              {bodyType === "none" && (
                <Typography
                  sx={{
                    color: "text.secondary",
                    fontSize: 13,
                    px: 1,
                    py: 2,
                  }}
                >
                  {t("composePage.noBody")}
                </Typography>
              )}

              {bodyType === "formdata" && (
                <EditableKeyValueTable
                  items={formDataEntries}
                  namePlaceholder={t("common.placeholders.paramName")}
                  onChange={onFormDataEntriesChange}
                  valuePlaceholder={t("common.placeholders.paramValue")}
                />
              )}

              {bodyType === "urlencoded" && (
                <EditableKeyValueTable
                  items={urlEncodedEntries}
                  namePlaceholder={t("common.placeholders.paramName")}
                  onChange={onUrlEncodedEntriesChange}
                  valuePlaceholder={t("common.placeholders.paramValue")}
                />
              )}

              {bodyType === "raw" && (
                <TextField
                  fullWidth
                  minRows={8}
                  multiline
                  placeholder={t("composePage.bodyPlaceholder")}
                  size="small"
                  sx={{
                    fontFamily: appFontCssVars.content,
                    "& .MuiOutlinedInput-root": {
                      alignItems: "flex-start",
                    },
                    "& .MuiInputBase-input": {
                      fontFamily: appFontCssVars.content,
                      fontSize: 13,
                      lineHeight: 1.5,
                    },
                  }}
                  value={body}
                  onChange={(event) => onBodyChange(event.target.value)}
                />
              )}
            </Stack>
          )}

          {activeTab === "query" && (
            <QueryParamsEditor
              namePlaceholder={t("common.placeholders.paramName")}
              url={url}
              onUrlChange={onUrlChange}
              valuePlaceholder={t("common.placeholders.paramValue")}
            />
          )}
        </Box>
      )}
    </Box>
  );
}

// Parse only the query string of a URL into name/value entries. Returns null
// when the URL is not yet parseable (so the caller can keep the previous state
// instead of clearing the editor mid-typing).
function parseQueryParams(url: string): HeaderEntry[] | null {
  try {
    const parsed = new URL(url);
    return Array.from(parsed.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return null;
  }
}

// Rebuild a URL string with the query replaced by the given params. Returns null
// when the base URL is not parseable.
function buildUrlWithParams(url: string, params: HeaderEntry[]): string | null {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    for (const entry of params) {
      if (entry.name.trim()) {
        parsed.searchParams.append(entry.name, entry.value);
      }
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function QueryParamsEditor({
  namePlaceholder,
  onUrlChange,
  url,
  valuePlaceholder,
}: {
  namePlaceholder: string;
  onUrlChange: (url: string) => void;
  url: string;
  valuePlaceholder: string;
}) {
  // H12: previously this editor re-derived `params` from `new URL(url)` on EVERY
  // render and pushed every keystroke back into the URL store. The URL round
  // trip (encoding is non-idempotent: spaces, `+`, special chars) made the
  // downstream table's `sameEntries` sync effect see a foreign value on each
  // key, regenerate row ids, and remount the focused input — so typing a param
  // value was effectively impossible.
  //
  // Now the editor owns a LOCAL params draft that is the single source for the
  // rendered rows. It only re-parses the URL when the change did NOT originate
  // here (e.g. the user edits the URL bar, or a saved request is loaded). Local
  // edits update the draft and write back to the URL, but the draft is NOT
  // re-parsed from the URL we just emitted.
  const [params, setParams] = useState<HeaderEntry[]>(() => parseQueryParams(url) ?? []);
  // Track the last URL we produced ourselves so we can distinguish our own
  // writes from external URL changes and avoid the round trip.
  const lastEmittedUrlRef = useRef<string>(url);

  // Re-sync the draft from the URL only on EXTERNAL changes. After we emit a
  // new URL via onChange we record it here, so the next render's `url` matches
  // and we skip the re-parse (preserving row identity / focus).
  useEffect(() => {
    if (url === lastEmittedUrlRef.current) return;
    const parsed = parseQueryParams(url);
    if (parsed) {
      setParams(parsed);
    }
    lastEmittedUrlRef.current = url;
  }, [url]);

  function handleParamsChange(newParams: HeaderEntry[]) {
    setParams(newParams);
    const nextUrl = buildUrlWithParams(url, newParams);
    if (nextUrl !== null) {
      lastEmittedUrlRef.current = nextUrl;
      onUrlChange(nextUrl);
    }
  }

  // The downstream `EditableKeyValueTable` already mirrors its `items` into
  // stable-keyed rows. The loss-of-focus bug came from us feeding it a freshly
  // URL-derived array on every keystroke; now `params` keeps a stable identity
  // across our own edits, so the table's sync effect sees no foreign value and
  // the focused input survives.
  return (
    <EditableKeyValueTable
      items={params}
      namePlaceholder={namePlaceholder}
      onChange={handleParamsChange}
      valuePlaceholder={valuePlaceholder}
    />
  );
}
