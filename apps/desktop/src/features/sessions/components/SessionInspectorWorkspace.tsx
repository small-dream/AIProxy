import { Alert, Box, Divider, Paper, Typography } from "@mui/material";
import { radiusTokens } from "@pharles/ui-tokens";
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";

import { useI18n } from "@/i18n";
import { getSurfaceShadow } from "@/themes/app-theme";
import { type RequestPaneHandle, SessionInspectorRequestPane } from "./SessionInspectorRequestPane";
import { type ResponsePaneHandle, SessionInspectorResponsePane } from "./SessionInspectorResponsePane";
import { InspectorSummaryBar } from "./SessionInspectorShared";
import {
  formatJsonText,
  getBodyText,
  parseFormEntries,
  parseJsonBody,
  type JsonParseResult,
  type RequestInspectorTab,
  type ResponseInspectorTab,
} from "./session-inspector.helpers";

export type WorkspaceHandle = {
  activateSearch: () => void;
};

type SessionInspectorWorkspaceProps = {
  detailErrorMessage: string | undefined;
  inspectorSplitRatio: number;
  isDetailLoading: boolean;
  onRepeat?: (() => void) | undefined;
  onRequestCollapsedChange: (collapsed: boolean) => void;
  onRequestTabChange: (tab: RequestInspectorTab) => void;
  onResponseTabChange: (tab: ResponseInspectorTab) => void;
  requestCollapsed: boolean;
  requestTab: RequestInspectorTab;
  responseTab: ResponseInspectorTab;
  selectedSession: SessionSummary | undefined;
  selectedSessionDetail: SessionDetail | undefined;
};

export const SessionInspectorWorkspace = forwardRef<WorkspaceHandle, SessionInspectorWorkspaceProps>(
function SessionInspectorWorkspace({
  detailErrorMessage,
  inspectorSplitRatio,
  isDetailLoading,
  onRepeat,
  onRequestCollapsedChange,
  onRequestTabChange,
  onResponseTabChange,
  requestCollapsed,
  requestTab,
  responseTab,
  selectedSession,
  selectedSessionDetail,
}, ref) {
  const { t } = useI18n();
  const [activePane, setActivePane] = useState<"request" | "response">("response");
  const requestPaneRef = useRef<RequestPaneHandle>(null);
  const responsePaneRef = useRef<ResponsePaneHandle>(null);

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

    return parseJsonBody(detail?.responseBody, responseBodyText, {
      responseErrorMessage: t("inspector.jsonParse.responseError"),
      tooLargeMessage: t("inspector.jsonParse.tooLarge"),
      truncatedMessage: t("inspector.jsonParse.truncated"),
    });
  }, [detail?.responseBody, responseBodyText, responseTab, t]);

  const responseJsonDisplayText = useMemo(() => {
    if (responseTab !== "jsonText" || responseJsonResult.status !== "success") {
      return undefined;
    }

    return formatJsonText(responseJsonResult.value);
  }, [responseJsonResult, responseTab]);

  const requestBodyDisplayText = useMemo(() => {
    if (!requestBodyText) {
      return t("inspector.request.bodyUnavailable");
    }

    const parsedRequestJson = parseJsonBody(detail?.requestBody, requestBodyText, {
      allowLargeTextFallback: true,
      preferSoftWarning: false,
      requestFallbackMessage: t("inspector.jsonParse.requestFallback"),
      tooLargeMessage: t("inspector.jsonParse.tooLarge"),
      truncatedMessage: t("inspector.jsonParse.truncated"),
    });

    if (parsedRequestJson.status === "success") {
      return formatJsonText(parsedRequestJson.value);
    }

    return requestBodyText;
  }, [detail?.requestBody, requestBodyText, t]);

  const activateSearch = useCallback(() => {
    if (activePane === "request") {
      requestPaneRef.current?.activateSearch();
    } else {
      responsePaneRef.current?.activateSearch();
    }
  }, [activePane]);

  useImperativeHandle(ref, () => ({ activateSearch }), [activateSearch]);

  if (!selectedSession) {
    return (
      <Paper
        elevation={0}
        sx={{
          border: 1,
          borderColor: "divider",
          borderRadius: `${radiusTokens.card}px`,
          boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
          display: "flex",
          minHeight: 0,
        }}
        variant="outlined"
      >
        <Box sx={{ p: 3 }}>
          <Typography variant="h6">{t("inspector.workspace.emptyTitle")}</Typography>
          <Typography color="text.secondary" variant="body2">
            {t("inspector.workspace.emptyDescription")}
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
        borderRadius: `${radiusTokens.card}px`,
        boxShadow: (theme) => getSurfaceShadow(theme.palette.mode),
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
      variant="outlined"
    >
      <InspectorSummaryBar detail={detail} onRepeat={onRepeat} session={selectedSession} />
      <Divider />

      {detailErrorMessage ? (
        <Alert severity="error" sx={{ borderRadius: 0 }}>
          {detailErrorMessage}
        </Alert>
      ) : null}

      {isDetailLoading && !detail ? (
        <Box sx={{ p: 2 }}>
          <Typography color="text.secondary" variant="body2">
            {t("inspector.workspace.loading")}
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
          overflow: "hidden",
        }}
      >
        <Box
          onClick={() => setActivePane("request")}
          sx={{
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <SessionInspectorRequestPane
            detail={detail}
            ref={requestPaneRef}
            onRequestCollapsedChange={onRequestCollapsedChange}
            onRequestTabChange={onRequestTabChange}
            requestBodyDisplayText={requestBodyDisplayText}
            requestCollapsed={requestCollapsed}
            requestFormEntries={requestFormEntries}
            requestTab={requestTab}
            session={selectedSession}
          />
        </Box>

        <Divider />

        <Box
          onClick={() => setActivePane("response")}
          sx={{
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <SessionInspectorResponsePane
            detail={detail}
            ref={responsePaneRef}
            onResponseTabChange={onResponseTabChange}
            responseJsonDisplayText={responseJsonDisplayText}
            responseJsonResult={responseJsonResult}
            responseTab={responseTab}
            session={selectedSession}
          />
        </Box>
      </Box>
    </Paper>
  );
});
