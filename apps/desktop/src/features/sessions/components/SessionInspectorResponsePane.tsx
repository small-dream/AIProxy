import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Alert, Box, Divider, OutlinedInput, Stack, Tab, Tabs, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";

import { SessionInspectorJsonTree } from "./SessionInspectorJsonTree";
import { InspectorDefinitionList, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  buildResponseSubtitle,
  describeBody,
  formatTiming,
  getBodyText,
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
        <Typography variant="subtitle2">Response</Typography>
        <Typography color="text.secondary" noWrap variant="caption">
          {buildResponseSubtitle(detail, session)}
        </Typography>
      </Stack>

      <Divider />

      <Tabs
        onChange={(_event, nextTab) => onResponseTabChange(nextTab as ResponseInspectorTab)}
        scrollButtons="auto"
        sx={{ bgcolor: "background.paper", minHeight: 32, px: 0.5 }}
        value={responseTab}
        variant="scrollable"
      >
        <Tab label="Overview" value="overview" />
        <Tab label={buildCountTabLabel("Headers", detail?.responseHeaders.length ?? 0)} value="headers" />
        <Tab label="Text" value="text" />
        <Tab label="JSON" value="json" />
        <Tab label="JSON Text" value="jsonText" />
        <Tab label="Raw" value="raw" />
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
              placeholder={responseTab === "json" ? "Search JSON tree" : "Search JSON text"}
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
  if (responseTab === "overview") {
    return (
      <InspectorDefinitionList
        items={[
          ["Status", String(session.statusCode)],
          ["Duration", `${session.durationMs} ms`],
          ["Size", `${session.sizeBytes} bytes`],
          ["Server IP", detail?.serverIp ?? "Unavailable in current HTTP phase"],
          ["Response Body", describeBody(detail?.responseBody) ?? "No response body captured"],
          ["Timing Total", formatTiming(detail?.timing?.totalMs)],
        ]}
      />
    );
  }

  if (responseTab === "headers") {
    return (
      <InspectorDefinitionList
        emptyMessage="No response headers captured."
        items={detail?.responseHeaders.map((entry) => [entry.name, entry.value]) ?? []}
      />
    );
  }

  if (responseTab === "raw") {
    return <SearchableCodeBlock code={detail?.rawResponse ?? "Raw response is not available."} searchQuery="" />;
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
          No JSON body available for this response.
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
            code={getBodyText(detail?.responseBody) ?? "No response body available."}
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
            : "No JSON body available for this response."
        }
        searchQuery={searchValue}
      />
    );
  }

  return (
    <Stack spacing={1}>
      <Typography color="text.secondary" variant="caption">
        {describeBody(detail?.responseBody) ?? "No body captured."}
      </Typography>
      <SearchableCodeBlock code={getBodyText(detail?.responseBody) ?? "No text response body available."} searchQuery="" />
    </Stack>
  );
}
