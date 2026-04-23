import { Alert, Box, Divider, Typography } from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { ensureSessionDetailContent } from "@/features/sessions/session-detail-content";
import { type RequestPaneHandle, SessionInspectorRequestPane } from "./SessionInspectorRequestPane";
import { type ResponsePaneHandle, SessionInspectorResponsePane } from "./SessionInspectorResponsePane";
import { InspectorSummaryBar } from "./SessionInspectorShared";
import {
  formatJsonText,
  getBodyText,
  getRawMessageText,
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
  onCopyCurl?: (() => void) | undefined;
  onCopyUrl?: (() => void) | undefined;
  onInspectorResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onRepeat?: (() => void) | undefined;
  onRequestCollapsedChange: (collapsed: boolean) => void;
  onRequestTabChange: (tab: RequestInspectorTab) => void;
  onResponseTabChange: (tab: ResponseInspectorTab) => void;
  requestCollapsed: boolean;
  requestTab: RequestInspectorTab;
  responseTab: ResponseInspectorTab;
  sessionSelectionNonce: number;
  selectedSession: SessionSummary | undefined;
  selectedSessionDetail: SessionDetail | undefined;
};

export const SessionInspectorWorkspace = forwardRef<WorkspaceHandle, SessionInspectorWorkspaceProps>(
function SessionInspectorWorkspace({
  detailErrorMessage,
  inspectorSplitRatio,
  isDetailLoading,
  onCopyCurl,
  onCopyUrl,
  onInspectorResizeStart,
  onRepeat,
  onRequestCollapsedChange,
  onRequestTabChange,
  onResponseTabChange,
  requestCollapsed,
  requestTab,
  responseTab,
  sessionSelectionNonce,
  selectedSession,
  selectedSessionDetail,
}, ref) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [activePane, setActivePane] = useState<"request" | "response">("response");
  const [contentLoading, setContentLoading] = useState<Record<string, boolean>>({});
  const requestPaneRef = useRef<RequestPaneHandle>(null);
  const responsePaneRef = useRef<ResponsePaneHandle>(null);

  const detail =
    selectedSessionDetail && selectedSession && selectedSessionDetail.id === selectedSession.id
      ? selectedSessionDetail
      : undefined;

  useEffect(() => {
    setContentLoading({});
  }, [selectedSession?.id]);

  const requestBodyText = getBodyText(detail?.requestBody);
  const responseBodyText = getBodyText(detail?.responseBody);
  const isMultipartRequestBody = (detail?.requestBody?.mimeType?.toLowerCase() ?? "").includes("multipart/form-data");
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
    if (responseJsonResult.status !== "success") {
      return undefined;
    }

    return formatJsonText(responseJsonResult.value);
  }, [responseJsonResult]);

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

  const loadDeferredContent = useCallback(async (
    key: "requestBodyText" | "requestBodyBase64" | "requestRaw" | "responseBodyText" | "responseRaw",
    request: {
      includeRequestBodyText?: boolean;
      includeRequestBodyBase64?: boolean;
      includeRawRequest?: boolean;
      includeResponseBodyText?: boolean;
      includeRawResponse?: boolean;
    },
  ) => {
    if (!selectedSession) {
      return;
    }

    setContentLoading((current) => {
      if (current[key]) {
        return current;
      }

      return {
        ...current,
        [key]: true,
      };
    });

    try {
      await ensureSessionDetailContent(queryClient, selectedSession.id, request);
    } finally {
      setContentLoading((current) => {
        if (!current[key]) {
          return current;
        }

        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }, [queryClient, selectedSession]);

  useEffect(() => {
    if (!selectedSession || !detail) {
      return;
    }

    if ((requestTab === "body" || requestTab === "form")
      && !isMultipartRequestBody
      && detail.requestBody?.textDeferred
      && detail.requestBody.inlineText === undefined
      && !contentLoading.requestBodyText
      && !contentLoading.requestRaw) {
      void loadDeferredContent("requestBodyText", { includeRequestBodyText: true });
    }

    if (requestTab === "form"
      && isMultipartRequestBody
      && detail.requestBody?.base64Deferred
      && detail.requestBody.base64Text === undefined
      && !contentLoading.requestBodyBase64) {
      void loadDeferredContent("requestBodyBase64", { includeRequestBodyBase64: true });
    }

    if (requestTab === "raw"
      && detail.rawRequestDeferred
      && getRawMessageText(detail.rawRequest, detail.rawRequestHead, detail.requestBody) === undefined
      && !contentLoading.requestRaw
      && !(detail.requestBody?.textDeferred && contentLoading.requestBodyText)) {
      void loadDeferredContent(
        "requestRaw",
        detail.requestBody?.textDeferred && detail.rawRequestHead
          ? { includeRequestBodyText: true }
          : { includeRawRequest: true },
      );
    }

    if ((responseTab === "text" || responseTab === "json" || responseTab === "jsonText")
      && detail.responseBody?.textDeferred
      && detail.responseBody.inlineText === undefined
      && !contentLoading.responseBodyText
      && !contentLoading.responseRaw) {
      void loadDeferredContent("responseBodyText", { includeResponseBodyText: true });
    }

    if (responseTab === "raw"
      && detail.rawResponseDeferred
      && getRawMessageText(detail.rawResponse, detail.rawResponseHead, detail.responseBody) === undefined
      && !contentLoading.responseRaw
      && !(detail.responseBody?.textDeferred && contentLoading.responseBodyText)) {
      void loadDeferredContent(
        "responseRaw",
        detail.responseBody?.textDeferred && detail.rawResponseHead
          ? { includeResponseBodyText: true }
          : { includeRawResponse: true },
      );
    }
  }, [
    contentLoading.requestBodyText,
    contentLoading.requestBodyBase64,
    contentLoading.requestRaw,
    contentLoading.responseBodyText,
    contentLoading.responseRaw,
    detail,
    isMultipartRequestBody,
    loadDeferredContent,
    requestBodyText,
    requestTab,
    responseBodyText,
    responseTab,
    selectedSession,
  ]);

  const isRequestBodyLoading = Boolean(contentLoading.requestBodyText);
  const isRequestFormLoading = isMultipartRequestBody
    ? Boolean(contentLoading.requestBodyBase64)
    : Boolean(contentLoading.requestBodyText);
  const isRequestRawLoading = Boolean(contentLoading.requestRaw);
  const isResponseBodyLoading = Boolean(contentLoading.responseBodyText);
  const isResponseRawLoading = Boolean(contentLoading.responseRaw);

  useImperativeHandle(ref, () => ({ activateSearch }), [activateSearch]);

  if (!selectedSession) {
    return (
      <Box
        sx={{
          bgcolor: "background.paper",
          display: "flex",
          minHeight: 0,
        }}
      >
        <Box sx={{ p: 3 }}>
          <Typography variant="h6">{t("inspector.workspace.emptyTitle")}</Typography>
          <Typography color="text.secondary" variant="body2">
            {t("inspector.workspace.emptyDescription")}
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <InspectorSummaryBar
        detail={detail}
        onCopyCurl={onCopyCurl}
        onCopyUrl={onCopyUrl}
        onRepeat={onRepeat}
        session={selectedSession}
      />
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
        data-testid="session-inspector-grid"
        sx={{
          display: "grid",
          flex: 1,
          gridTemplateRows: requestCollapsed
            ? "auto 1px minmax(0, 1fr)"
            : `${inspectorSplitRatio}fr 8px ${1 - inspectorSplitRatio}fr`,
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
            key={`${selectedSession.id}:${sessionSelectionNonce}:request`}
            detail={detail}
            ref={requestPaneRef}
            onRequestCollapsedChange={onRequestCollapsedChange}
            onRequestTabChange={onRequestTabChange}
            isRequestBodyLoading={isRequestBodyLoading}
            isRequestFormLoading={isRequestFormLoading}
            isRequestRawLoading={isRequestRawLoading}
            requestBodyDisplayText={requestBodyDisplayText}
            requestCollapsed={requestCollapsed}
            requestFormEntries={requestFormEntries}
            requestTab={requestTab}
            session={selectedSession}
          />
        </Box>

        {requestCollapsed ? (
          <Divider />
        ) : (
          <Box
            aria-hidden
            data-testid="session-inspector-splitter"
            onPointerDown={onInspectorResizeStart}
            sx={{
              alignItems: "center",
              cursor: "row-resize",
              display: "flex",
              justifyContent: "center",
              minHeight: 0,
              position: "relative",
              touchAction: "none",
              userSelect: "none",
              "&::before": {
                bgcolor: "divider",
                borderRadius: 999,
                content: '""',
                height: 2,
                opacity: 0.7,
                transition: "background-color 120ms ease, opacity 120ms ease",
                width: "100%",
              },
              "&:hover::before": {
                bgcolor: "primary.main",
                opacity: 1,
              },
            }}
          />
        )}

        <Box
          onClick={() => setActivePane("response")}
          sx={{
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <SessionInspectorResponsePane
            key={`${selectedSession.id}:${sessionSelectionNonce}:response`}
            detail={detail}
            ref={responsePaneRef}
            isResponseBodyLoading={isResponseBodyLoading}
            isResponseRawLoading={isResponseRawLoading}
            onResponseTabChange={onResponseTabChange}
            responseJsonDisplayText={responseJsonDisplayText}
            responseJsonResult={responseJsonResult}
            responseTab={responseTab}
            session={selectedSession}
          />
        </Box>
      </Box>
    </Box>
  );
});
