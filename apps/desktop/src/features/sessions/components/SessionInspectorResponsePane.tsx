import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Alert, Box, Chip, Divider, OutlinedInput, Stack, Tab, Tabs, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";

import { useI18n } from "@/i18n";
import { SessionInspectorJsonTree } from "./SessionInspectorJsonTree";
import { InspectorDefinitionList, InspectorKeyValueTable, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  describeBody,
  formatTiming,
  getBodyText,
  getStatusColor,
  type JsonParseResult,
  type ResponseInspectorTab,
} from "./session-inspector.helpers";

export function SessionInspectorResponsePane({
  detail,
  responseJsonResult,
  responseTab,
  session,
  onResponseTabChange,
}: {
  detail: SessionDetail | undefined;
  onResponseTabChange: (tab: ResponseInspectorTab) => void;
  responseJsonResult: JsonParseResult;
  responseTab: ResponseInspectorTab;
  session: SessionSummary;
}) {
  const { t } = useI18n();
  const [searchValue, setSearchValue] = useState("");
  const showSearch = responseTab === "json" || responseTab === "jsonText";

  useEffect(() => {
    setSearchValue("");
  }, [session.id]);

  useEffect(() => {
    if (!showSearch) {
      setSearchValue("");
    }
  }, [showSearch]);

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

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 2 }}>
        <ResponseTabContent
          detail={detail}
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
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder={responseTab === "json" ? t("inspector.response.jsonSearchPlaceholder") : t("inspector.response.jsonTextSearchPlaceholder")}
              size="small"
              startAdornment={<SearchRoundedIcon fontSize="small" sx={{ mr: 1 }} />}
              value={searchValue}
            />
          </Box>
        </>
      ) : null}
    </Stack>
  );
}

function ResponseTabContent({
  detail,
  responseJsonResult,
  responseTab,
  searchValue,
  session,
}: {
  detail: SessionDetail | undefined;
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
    );
  }

  if (responseTab === "headers") {
    return (
      <InspectorKeyValueTable
        emptyMessage={t("inspector.response.emptyHeaders")}
        items={detail?.responseHeaders.map((entry) => [entry.name, entry.value]) ?? []}
      />
    );
  }

  if (responseTab === "raw") {
    return <SearchableCodeBlock code={detail?.rawResponse ?? t("inspector.response.rawUnavailable")} searchQuery="" />;
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
        <Typography color="text.secondary" variant="body2">
          {t("inspector.response.noJsonBody")}
        </Typography>
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
        code={
          responseJsonResult.status === "success"
            ? responseJsonResult.prettyText
            : t("inspector.response.noJsonBody")
        }
        language="json"
        searchQuery={searchValue}
      />
    );
  }

  return (
    <Stack spacing={1}>
      <Typography color="text.secondary" variant="caption">
        {bodyDescription ?? t("common.tech.noBodyCaptured")}
      </Typography>
      <SearchableCodeBlock code={getBodyText(detail?.responseBody) ?? t("inspector.response.noTextBody")} searchQuery="" />
    </Stack>
  );
}
