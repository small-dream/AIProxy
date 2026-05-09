import {
  Box,
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

import { type BodyType, RAW_LANGUAGES, type RawLanguage } from "@/features/compose/compose-editor.store";
import { inspectorTabsSx } from "@/features/sessions/components/SessionInspectorShared";
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
  formDataEntries: HeaderEntry[];
  headers: HeaderEntry[];
  onActiveTabChange: (tab: "headers" | "body" | "query") => void;
  onBodyChange: (body: string) => void;
  onBodyTypeChange: (bodyType: BodyType) => void;
  onFormDataEntriesChange: (entries: HeaderEntry[]) => void;
  onHeadersChange: (entries: HeaderEntry[]) => void;
  onRawLanguageChange: (rawLanguage: RawLanguage) => void;
  onUrlChange: (url: string) => void;
  onUrlEncodedEntriesChange: (entries: HeaderEntry[]) => void;
  rawLanguage: RawLanguage;
  url: string;
  urlEncodedEntries: HeaderEntry[];
};

export function ComposeRequestSection({
  activeTab,
  body,
  bodyType,
  formDataEntries,
  headers,
  onActiveTabChange,
  onBodyChange,
  onBodyTypeChange,
  onFormDataEntriesChange,
  onHeadersChange,
  onRawLanguageChange,
  onUrlChange,
  onUrlEncodedEntriesChange,
  rawLanguage,
  url,
  urlEncodedEntries,
}: ComposeRequestSectionProps) {
  const { t } = useI18n();

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === "dark" ? 0.72 : 0.9),
          display: "flex",
          minHeight: 42,
          px: 0.75,
        })}
      >
        <Tabs
          onChange={(_, value) => onActiveTabChange(value)}
          sx={inspectorTabsSx}
          value={activeTab}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab label={`${t("composePage.tabs.headers")}${headers.length > 0 ? ` (${headers.length})` : ""}`} value="headers" />
          <Tab label={t("composePage.tabs.body")} value="body" />
          <Tab label={t("composePage.tabs.query")} value="query" />
        </Tabs>
      </Box>
      <Divider />

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2, py: 1.5 }}>
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
                  bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.05 : 0.035),
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
                      boxShadow: theme.palette.mode === "dark"
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
                  <ToggleButton
                    key={type}
                    value={type}
                  >
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
                    <MenuItem key={lang.value} sx={{ fontFamily: appFontCssVars.content, fontSize: 11 }} value={lang.value}>
                      {t(lang.labelKey)}
                    </MenuItem>
                  ))}
                </Select>
              )}
            </Stack>

            <Divider />

            {bodyType === "none" && (
              <Typography color="text.secondary" sx={{ fontSize: 13, px: 1, py: 2 }}>
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
    </Box>
  );
}

function QueryParamsEditor({
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
  let params: HeaderEntry[] = [];

  try {
    const parsed = new URL(url);
    params = Array.from(parsed.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    // URL not valid yet, show empty
  }

  function handleParamsChange(newParams: HeaderEntry[]) {
    try {
      const parsed = new URL(url);
      parsed.search = "";
      for (const entry of newParams) {
        if (entry.name.trim()) {
          parsed.searchParams.append(entry.name, entry.value);
        }
      }
      onUrlChange(parsed.toString());
    } catch {
      // Can't update query if URL is invalid
    }
  }

  return (
    <EditableKeyValueTable
      items={params}
      namePlaceholder={namePlaceholder}
      onChange={handleParamsChange}
      valuePlaceholder={valuePlaceholder}
    />
  );
}
