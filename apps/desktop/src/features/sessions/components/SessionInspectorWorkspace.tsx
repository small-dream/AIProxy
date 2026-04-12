import { Alert, Box, Divider, Paper, Typography } from "@mui/material";
import { useMemo } from "react";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";

import { SessionInspectorRequestPane } from "./SessionInspectorRequestPane";
import { SessionInspectorResponsePane } from "./SessionInspectorResponsePane";
import { InspectorSummaryBar } from "./SessionInspectorShared";
import {
  getBodyText,
  parseFormEntries,
  parseJsonBody,
  type JsonParseResult,
  type RequestInspectorTab,
  type ResponseInspectorTab,
} from "./session-inspector.helpers";

type SessionInspectorWorkspaceProps = {
  detailErrorMessage: string | undefined;
  inspectorSplitRatio: number;
  isDetailLoading: boolean;
  onRequestCollapsedChange: (collapsed: boolean) => void;
  onRequestTabChange: (tab: RequestInspectorTab) => void;
  onResponseTabChange: (tab: ResponseInspectorTab) => void;
  requestCollapsed: boolean;
  requestTab: RequestInspectorTab;
  responseTab: ResponseInspectorTab;
  selectedSession: SessionSummary | undefined;
  selectedSessionDetail: SessionDetail | undefined;
};

export function SessionInspectorWorkspace({
  detailErrorMessage,
  inspectorSplitRatio,
  isDetailLoading,
  onRequestCollapsedChange,
  onRequestTabChange,
  onResponseTabChange,
  requestCollapsed,
  requestTab,
  responseTab,
  selectedSession,
  selectedSessionDetail,
}: SessionInspectorWorkspaceProps) {
  const detail =
    selectedSessionDetail && selectedSession && selectedSessionDetail.id === selectedSession.id
      ? selectedSessionDetail
      : undefined;

  const requestBodyText = getBodyText(detail?.requestBody);
  const responseBodyText = getBodyText(detail?.responseBody);
  const requestFormEntries = useMemo(() => parseFormEntries(detail?.requestBody), [detail?.requestBody]);

  const responseJsonResult = useMemo<JsonParseResult>(() => {
    if (responseTab !== "json" && responseTab !== "jsonText") {
      return { status: "idle" };
    }

    return parseJsonBody(detail?.responseBody, responseBodyText);
  }, [detail?.responseBody, responseBodyText, responseTab]);

  const requestBodyDisplayText = useMemo(() => {
    if (!requestBodyText) {
      return "No request body available.";
    }

    const parsedRequestJson = parseJsonBody(detail?.requestBody, requestBodyText, {
      allowLargeTextFallback: true,
      preferSoftWarning: false,
    });

    if (parsedRequestJson.status === "success") {
      return parsedRequestJson.prettyText;
    }

    return requestBodyText;
  }, [detail?.requestBody, requestBodyText]);

  if (!selectedSession) {
    return (
      <Paper
        elevation={0}
        sx={{
          border: 1,
          borderColor: "divider",
          display: "flex",
          minHeight: 0,
        }}
        variant="outlined"
      >
        <Box sx={{ p: 3 }}>
          <Typography variant="h6">Inspector Workspace</Typography>
          <Typography color="text.secondary" variant="body2">
            Select a captured request to inspect headers, body, timing, and raw HTTP messages.
          </Typography>
        </Box>
      </Paper>
    );
  }

  return (
    <Paper
      elevation={0}
      sx={{
        border: 1,
        borderColor: "divider",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
      variant="outlined"
    >
      <InspectorSummaryBar detail={detail} session={selectedSession} />
      <Divider />

      {detailErrorMessage ? (
        <Alert severity="error" sx={{ borderRadius: 0 }}>
          {detailErrorMessage}
        </Alert>
      ) : null}

      {isDetailLoading && !detail ? (
        <Box sx={{ p: 2 }}>
          <Typography color="text.secondary" variant="body2">
            Loading selected session detail...
          </Typography>
        </Box>
      ) : null}

      <Box
        sx={{
          display: "grid",
          flex: 1,
          gridTemplateRows: requestCollapsed
            ? "auto 1px minmax(0, 1fr)"
            : `${inspectorSplitRatio}fr 1px ${1 - inspectorSplitRatio}fr`,
          minHeight: 0,
        }}
      >
        <SessionInspectorRequestPane
          detail={detail}
          onRequestCollapsedChange={onRequestCollapsedChange}
          onRequestTabChange={onRequestTabChange}
          requestBodyDisplayText={requestBodyDisplayText}
          requestCollapsed={requestCollapsed}
          requestFormEntries={requestFormEntries}
          requestTab={requestTab}
          session={selectedSession}
        />

        <Divider />

        <SessionInspectorResponsePane
          detail={detail}
          onResponseTabChange={onResponseTabChange}
          responseJsonResult={responseJsonResult}
          responseTab={responseTab}
          session={selectedSession}
        />
      </Box>
    </Paper>
  );
}
