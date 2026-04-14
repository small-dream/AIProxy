import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Alert, Box, Chip, Divider, OutlinedInput, Stack, Tab, Tabs, Typography } from "@mui/material";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";

import { useI18n } from "@/i18n";
import { SessionInspectorJsonTree } from "./SessionInspectorJsonTree";
import { InspectorDefinitionList, InspectorKeyValueTable, InspectorScrollArea, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  describeBody,
  formatTiming,
  getBodyText,
  getStatusColor,
  type JsonParseResult,
  type ResponseInspectorTab,
} from "./session-inspector.helpers";

export type ResponsePaneHandle = {
  activateSearch: () => void;
};

const SEARCHABLE_TABS: ReadonlySet<ResponseInspectorTab> = new Set(["json", "jsonText", "raw", "text"]);

export const SessionInspectorResponsePane = forwardRef<ResponsePaneHandle, {
  detail: SessionDetail | undefined;
  onResponseTabChange: (tab: ResponseInspectorTab) => void;
  responseJsonDisplayText: string | undefined;
  responseJsonResult: JsonParseResult;
  responseTab: ResponseInspectorTab;
  session: SessionSummary;
}>(function SessionInspectorResponsePane({
  detail,
  onResponseTabChange,
  responseJsonDisplayText,
  responseJsonResult,
  responseTab,
  session,
}, ref) {
  const { t } = useI18n();
  const [searchValue, setSearchValue] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const showSearch = SEARCHABLE_TABS.has(responseTab);

  useEffect(() => {
    setSearchValue("");
  }, [session.id]);

  useEffect(() => {
    if (!showSearch) {
      setSearchValue("");
    }
  }, [showSearch]);

  const activateSearch = useCallback(() => {
    if (!SEARCHABLE_TABS.has(responseTab)) return;
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [responseTab]);

  useImperativeHandle(ref, () => ({ activateSearch }), [activateSearch]);

  const searchPlaceholder =
    responseTab === "json" ? t("inspector.response.jsonSearchPlaceholder") :
    responseTab === "jsonText" ? t("inspector.response.jsonTextSearchPlaceholder") :
    responseTab === "raw" ? t("inspector.response.rawSearchPlaceholder") :
    t("inspector.response.rawSearchPlaceholder");

  return (
    <Stack minHeight={0} spacing={0} sx={{ overflow: "hidden" }}>
      <Stack spacing={0.5} sx={{ px: 1.5, py: 1 }}>
        <Typography variant="subtitle2">{t("inspector.response.sectionTitle")}</Typography>
      </Stack>

      <Divider />

      <Tabs
        onChange={(_event, nextTab) => onResponseTabChange(nextTab as ResponseInspectorTab)}
        scrollButtons="auto"
        sx={{ bgcolor: "background.paper", minHeight: 32, px: 0.5 }}
        value={responseTab}
        variant="scrollable"
      >
        <Tab label={t("inspector.response.tabs.overview")} value="overview" />
        <Tab label={buildCountTabLabel(t("inspector.response.tabs.headers"), detail?.responseHeaders.length ?? 0)} value="headers" />
        <Tab label={t("inspector.response.tabs.text")} value="text" />
        <Tab label={t("inspector.response.tabs.json")} value="json" />
        <Tab label={t("inspector.response.tabs.jsonText")} value="jsonText" />
        <Tab label={t("inspector.response.tabs.raw")} value="raw" />
      </Tabs>

      <Divider />

      <Box sx={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden", p: 2 }}>
        <ResponseTabContent
          detail={detail}
          responseJsonDisplayText={responseJsonDisplayText}
          responseJsonResult={responseJsonResult}
          responseTab={responseTab}
          searchValue={searchValue}
          session={session}
        />
      </Box>

      {showSearch ? (
        <>
          <Divider />
          <Box sx={{ p: 1.5 }}>
            <OutlinedInput
              fullWidth
              inputRef={searchInputRef}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder={searchPlaceholder}
              size="small"
              startAdornment={<SearchRoundedIcon fontSize="small" sx={{ mr: 1 }} />}
              value={searchValue}
            />
          </Box>
        </>
      ) : null}
    </Stack>
  );
});

function ResponseTabContent({
  detail,
  responseJsonDisplayText,
  responseJsonResult,
  responseTab,
  searchValue,
  session,
}: {
  detail: SessionDetail | undefined;
  responseJsonDisplayText: string | undefined;
  responseJsonResult: JsonParseResult;
  responseTab: ResponseInspectorTab;
  searchValue: string;
  session: SessionSummary;
}) {
  const { t } = useI18n();
  const bodyDescription = describeBody(detail?.responseBody, {
    formatBytes: (value) => t("common.tech.bytes", { value }),
    truncatedPreviewLabel: t("common.tech.truncatedPreview"),
    unknownMimeTypeLabel: t("common.tech.unknownMimeType"),
  });

  if (responseTab === "overview") {
    return (
      <InspectorScrollArea>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
            <Chip color={getStatusColor(session.statusCode)} label={String(session.statusCode)} size="small" variant="outlined" />
          </Stack>
          <InspectorDefinitionList
            items={[
              [t("common.labels.duration"), t("common.tech.milliseconds", { value: session.durationMs })],
              [t("common.labels.size"), t("common.tech.bytes", { value: session.sizeBytes })],
              [t("inspector.response.serverIp"), detail?.serverIp ?? t("common.states.unavailable")],
              [t("inspector.response.responseBody"), bodyDescription ?? t("inspector.response.noResponseBodyCaptured")],
              [t("inspector.response.timingTotal"), formatTiming(detail?.timing?.totalMs, t("common.states.notCaptured"))],
            ]}
          />
        </Stack>
      </InspectorScrollArea>
    );
  }

  if (responseTab === "headers") {
    return (
      <InspectorScrollArea>
        <InspectorKeyValueTable
          emptyMessage={t("inspector.response.emptyHeaders")}
          items={detail?.responseHeaders.map((entry) => [entry.name, entry.value]) ?? []}
        />
      </InspectorScrollArea>
    );
  }

  if (responseTab === "raw") {
    return <SearchableCodeBlock code={detail?.rawResponse ?? t("inspector.response.rawUnavailable")} searchQuery={searchValue} />;
  }

  if (responseTab === "json") {
    if (responseJsonResult.status === "tooLarge") {
      return <Alert severity="info">{responseJsonResult.message}</Alert>;
    }

    if (responseJsonResult.status === "error") {
      return <Alert severity="warning">{responseJsonResult.message}</Alert>;
    }

    if (responseJsonResult.status !== "success") {
      return (
        <InspectorScrollArea>
          <Typography color="text.secondary" variant="body2">
            {t("inspector.response.noJsonBody")}
          </Typography>
        </InspectorScrollArea>
      );
    }

    return <SessionInspectorJsonTree searchQuery={searchValue} value={responseJsonResult.value} />;
  }

  if (responseTab === "jsonText") {
    if (responseJsonResult.status === "tooLarge") {
      return (
        <Stack spacing={1.5}>
          <Alert severity="info">{responseJsonResult.message}</Alert>
          <SearchableCodeBlock
            code={getBodyText(detail?.responseBody) ?? t("composePage.responseNoBody")}
            language="json"
            searchQuery={searchValue}
          />
        </Stack>
      );
    }

    if (responseJsonResult.status === "error") {
      return <Alert severity="warning">{responseJsonResult.message}</Alert>;
    }

    return (
      <SearchableCodeBlock
        code={responseJsonResult.status === "success" ? (responseJsonDisplayText ?? t("inspector.response.noJsonBody")) : t("inspector.response.noJsonBody")}
        language="json"
        searchQuery={searchValue}
      />
    );
  }

  return (
    <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
      <Typography color="text.secondary" variant="caption">
        {bodyDescription ?? t("common.tech.noBodyCaptured")}
      </Typography>
      <SearchableCodeBlock code={getBodyText(detail?.responseBody) ?? t("inspector.response.noTextBody")} searchQuery={searchValue} />
    </Stack>
  );
}
