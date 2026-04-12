import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, Button, Divider, Stack, Tab, Tabs, Typography } from "@mui/material";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";

import { InspectorDefinitionList, InspectorKeyValueTable, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  describeBody,
  type RequestInspectorTab,
} from "./session-inspector.helpers";

export function SessionInspectorRequestPane({
  detail,
  onRequestCollapsedChange,
  onRequestTabChange,
  requestBodyDisplayText,
  requestCollapsed,
  requestFormEntries,
  requestTab,
  session,
}: {
  detail: SessionDetail | undefined;
  onRequestCollapsedChange: (collapsed: boolean) => void;
  onRequestTabChange: (tab: RequestInspectorTab) => void;
  requestBodyDisplayText: string;
  requestCollapsed: boolean;
  requestFormEntries: Array<[string, string]>;
  requestTab: RequestInspectorTab;
  session: SessionSummary;
}) {
  return (
    <Stack minHeight={0} spacing={0} sx={{ overflow: "hidden" }}>
      <Stack spacing={0.5} sx={{ px: 1.5, py: 1 }}>
        <Stack alignItems="center" direction="row" justifyContent="space-between" spacing={1}>
          <Typography variant="subtitle2">Request</Typography>
          <Button
            onClick={() => onRequestCollapsedChange(!requestCollapsed)}
            size="small"
            startIcon={requestCollapsed ? <ExpandMoreRoundedIcon /> : <ExpandLessRoundedIcon />}
            sx={{ minWidth: 0, px: 1.25 }}
            variant="text"
          >
            {requestCollapsed ? "Expand" : "Collapse"}
          </Button>
        </Stack>
      </Stack>

      {requestCollapsed ? null : (
        <>
          <Divider />
          <Tabs
            onChange={(_event, nextTab) => onRequestTabChange(nextTab as RequestInspectorTab)}
            scrollButtons="auto"
            sx={{ bgcolor: "background.paper", minHeight: 32, px: 0.5 }}
            value={requestTab}
            variant="scrollable"
          >
            <Tab label="Overview" value="overview" />
            <Tab label={buildCountTabLabel("Query", detail?.queryParams.length ?? 0)} value="query" />
            <Tab label={buildCountTabLabel("Headers", detail?.requestHeaders.length ?? 0)} value="headers" />
            <Tab label="Body" value="body" />
            <Tab label={buildCountTabLabel("Form", requestFormEntries.length)} value="form" />
            <Tab label="Raw" value="raw" />
          </Tabs>
          <Divider />
        </>
      )}

      {requestCollapsed ? null : (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 2 }}>
          <RequestTabContent
            detail={detail}
            requestBodyDisplayText={requestBodyDisplayText}
            requestFormEntries={requestFormEntries}
            requestTab={requestTab}
            session={session}
          />
        </Box>
      )}
    </Stack>
  );
}

function RequestTabContent({
  detail,
  requestBodyDisplayText,
  requestFormEntries,
  requestTab,
  session,
}: {
  detail: SessionDetail | undefined;
  requestBodyDisplayText: string;
  requestFormEntries: Array<[string, string]>;
  requestTab: RequestInspectorTab;
  session: SessionSummary;
}) {
  if (requestTab === "overview") {
    return (
      <Stack spacing={2}>
        <InspectorDefinitionList
          items={[
            ["Method", session.method],
            ["Host", session.host],
            ["Path", session.path || "/"],
            ["Protocol", session.protocol],
            ["URL", session.url],
            ["Started", session.startedAt],
            ["Finished", session.finishedAt],
            ["Body", describeBody(detail?.requestBody) ?? "No request body captured"],
          ]}
        />
        <Stack spacing={1}>
          <Typography variant="subtitle2">Cookies</Typography>
          <InspectorDefinitionList
            emptyMessage="No cookie headers captured."
            items={detail?.cookies.map((entry) => [entry.name, entry.value]) ?? []}
          />
        </Stack>
      </Stack>
    );
  }

  if (requestTab === "query") {
    return (
      <InspectorKeyValueTable
        emptyMessage="No query parameters."
        items={detail?.queryParams.map((entry) => [entry.name, entry.value]) ?? []}
      />
    );
  }

  if (requestTab === "headers") {
    return (
      <InspectorKeyValueTable
        emptyMessage="No request headers captured."
        items={detail?.requestHeaders.map((entry) => [entry.name, entry.value]) ?? []}
      />
    );
  }

  if (requestTab === "form") {
    return (
      <Stack spacing={1}>
        <Typography color="text.secondary" variant="caption">
          {describeBody(detail?.requestBody) ?? "No body captured."}
        </Typography>
        <InspectorDefinitionList
          emptyMessage="No form fields detected in the request body."
          items={requestFormEntries}
        />
      </Stack>
    );
  }

  if (requestTab === "raw") {
    return <SearchableCodeBlock code={detail?.rawRequest ?? "Raw request is not available."} searchQuery="" />;
  }

  return (
    <Stack spacing={1}>
      <Typography color="text.secondary" variant="caption">
        {describeBody(detail?.requestBody) ?? "No body captured."}
      </Typography>
      <SearchableCodeBlock code={requestBodyDisplayText} searchQuery="" />
    </Stack>
  );
}
