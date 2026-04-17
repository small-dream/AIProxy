import { Box, Divider, FormControlLabel, MenuItem, Radio, RadioGroup, Select, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import type { HeaderEntry } from "@aiproxy/shared-types";

import { type BodyType, RAW_LANGUAGES, type RawLanguage } from "@/features/compose/compose-editor.store";
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
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
      <Tabs
        onChange={(_, value) => onActiveTabChange(value)}
        sx={{ minHeight: 32, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}
        TabIndicatorProps={{ sx: { height: 2 } }}
        value={activeTab}
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab label={`${t("composePage.tabs.headers")}${headers.length > 0 ? ` (${headers.length})` : ""}`} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="headers" />
        <Tab label={t("composePage.tabs.body")} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="body" />
        <Tab label={t("composePage.tabs.query")} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="query" />
      </Tabs>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pt: 1.5, px: 0.5 }}>
        {activeTab === "headers" && (
          <EditableKeyValueTable
            items={headers}
            namePlaceholder={t("common.placeholders.headerName")}
            onChange={onHeadersChange}
            valuePlaceholder={t("common.placeholders.headerValue")}
          />
        )}

        {activeTab === "body" && (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <RadioGroup
                row
                sx={{ gap: 1.5, flexWrap: "nowrap" }}
                value={bodyType}
                onChange={(event) => onBodyTypeChange(event.target.value as BodyType)}
              >
                {(["none", "formdata", "urlencoded", "raw"] as const).map((type) => (
                  <FormControlLabel
                    key={type}
                    value={type}
                    control={<Radio size="small" sx={{ py: 0, px: 0.5 }} />}
                    label={<Typography sx={{ fontSize: 12, whiteSpace: "nowrap" }}>{t(BODY_TYPE_KEYS[type])}</Typography>}
                    sx={{ mr: 0, gap: 0.25, "& .MuiFormControlLabel-label": { fontSize: 12 } }}
                  />
                ))}
              </RadioGroup>
              {bodyType === "raw" && (
                <Select
                  size="small"
                  sx={{ height: 26, fontFamily: appFontCssVars.content, fontSize: 11, "& .MuiSelect-select": { py: 0.25, pr: 3 } }}
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

            <Divider sx={{ mt: 0 }} />

            {bodyType === "none" && (
              <Typography color="text.secondary" sx={{ fontSize: 12, py: 2, textAlign: "center" }}>
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
                minRows={6}
                multiline
                placeholder={t("composePage.bodyPlaceholder")}
                size="small"
                sx={{
                  fontFamily: appFontCssVars.content,
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
