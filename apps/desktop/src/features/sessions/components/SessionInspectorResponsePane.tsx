import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Alert, Box, Divider, IconButton, Snackbar, Stack, Tab, Tabs, Tooltip, Typography } from "@mui/material";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { SessionInspectorJsonTree } from "./SessionInspectorJsonTree";
import { SessionInspectorAutomationPane } from "./SessionInspectorAutomationPane";
import { SessionInspectorMessagesPane } from "./SessionInspectorMessagesPane";
import { SessionInspectorOverview } from "./SessionInspectorOverview";
import { InspectorKeyValueTable, InspectorScrollArea, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  describeBody,
  getBodyText,
  getRawMessageText,
  type JsonParseResult,
  type ResponseInspectorTab,
  type SearchMatcher,
} from "./session-inspector.helpers";
import { isWebSocketSession } from "./session-inspector.helpers";
import { SearchBar } from "./SearchBar";
import { useSearchController } from "./use-search-controller";

export type ResponsePaneHandle = {
  activateSearch: () => void;
};

const SEARCHABLE_TABS: ReadonlySet<ResponseInspectorTab> = new Set(["json", "jsonText", "raw", "text"]);
type ResponseContentKind = "binary" | "json" | "text";

function getResponseContentKind(
  detail: SessionDetail | undefined,
  session: SessionSummary,
): ResponseContentKind {
  const mimeType = (detail?.responseBody?.mimeType ?? session.responseMimeType ?? "").toLowerCase();

  if (mimeType.includes("application/json") || mimeType.includes("+json")) {
    return "json";
  }

  if (
    mimeType.startsWith("text/")
    || mimeType.includes("xml")
    || mimeType.includes("javascript")
    || mimeType.includes("ecmascript")
    || mimeType.includes("svg")
    || mimeType.includes("x-www-form-urlencoded")
    || detail?.responseBody?.inlineText !== undefined
    || detail?.responseBody?.textDeferred
  ) {
    return "text";
  }

  return "binary";
}

function getVisibleResponseTabs(
  detail: SessionDetail | undefined,
  session: SessionSummary,
): ResponseInspectorTab[] {
  if (isWebSocketSession(session)) {
    return ["overview", "messages", "headers", "raw"];
  }

  const responseContentKind = getResponseContentKind(detail, session);

  if (responseContentKind === "json") {
    return ["overview", "json", "jsonText", "headers", "raw", "automation"];
  }

  if (responseContentKind === "text") {
    return ["overview", "text", "headers", "raw", "automation"];
  }

  return ["overview", "headers", "raw", "automation"];
}

export const SessionInspectorResponsePane = forwardRef<ResponsePaneHandle, {
  detail: SessionDetail | undefined;
  isResponseBodyLoading: boolean;
  isResponseRawLoading: boolean;
  onResponseTabChange: (tab: ResponseInspectorTab) => void;
  responseJsonDisplayText: string | undefined;
  responseJsonResult: JsonParseResult;
  responseTab: ResponseInspectorTab;
  session: SessionSummary;
}>(function SessionInspectorResponsePane({
  detail,
  isResponseBodyLoading,
  isResponseRawLoading,
  onResponseTabChange,
  responseJsonDisplayText,
  responseJsonResult,
  responseTab,
  session,
}, ref) {
  const { t } = useI18n();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const searchController = useSearchController();
  const visibleTabs = useMemo(() => getVisibleResponseTabs(detail, session), [detail, session]);
  const activeResponseTab = visibleTabs.includes(responseTab) ? responseTab : "overview";
  const isSearchable = SEARCHABLE_TABS.has(activeResponseTab);

  useEffect(() => {
    setIsSearchOpen(false);
    setSnackbarOpen(false);
  }, [session.id]);

  useEffect(() => {
    if (!visibleTabs.includes(responseTab)) {
      onResponseTabChange("overview");
    }
  }, [onResponseTabChange, responseTab, visibleTabs]);

  useEffect(() => {
    if (!isSearchable) {
      setIsSearchOpen(false);
    }
  }, [isSearchable]);

  const activateSearch = useCallback(() => {
    if (!isSearchable) return;
    setIsSearchOpen(true);
  }, [isSearchable]);

  useImperativeHandle(ref, () => ({ activateSearch }), [activateSearch]);

  const searchPlaceholder =
    activeResponseTab === "json" ? t("inspector.response.jsonSearchPlaceholder") :
    activeResponseTab === "jsonText" ? t("inspector.response.jsonTextSearchPlaceholder") :
    activeResponseTab === "raw" ? t("inspector.response.rawSearchPlaceholder") :
    t("inspector.response.rawSearchPlaceholder");
  const copyValue = useMemo(() => {
    if (activeResponseTab === "json" || activeResponseTab === "jsonText") {
      return responseJsonDisplayText ?? getBodyText(detail?.responseBody) ?? "";
    }

    if (activeResponseTab === "raw") {
      return getRawMessageText(detail?.rawResponse, detail?.rawResponseHead, detail?.responseBody) ?? "";
    }

    if (activeResponseTab === "text") {
      return getBodyText(detail?.responseBody) ?? "";
    }

    return "";
  }, [activeResponseTab, detail?.rawResponse, detail?.rawResponseHead, detail?.responseBody, responseJsonDisplayText]);

  const handleCopy = useCallback(async () => {
    if (!copyValue) return;
    await navigator.clipboard?.writeText(copyValue);
    setSnackbarOpen(true);
  }, [copyValue]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    searchController.onQueryChange("");
  }, [searchController]);

  return (
    <Stack minHeight={0} spacing={0} sx={{ height: "100%", overflow: "hidden", position: "relative", width: "100%" }}>

      <Box sx={{ alignItems: "center", bgcolor: "background.paper", display: "flex", minHeight: 32, pr: 0.5 }}>
        <Tabs
          onChange={(_event, nextTab) => onResponseTabChange(nextTab as ResponseInspectorTab)}
          scrollButtons="auto"
          sx={{ flex: 1, minHeight: 32, minWidth: 0, px: 0.5 }}
          value={activeResponseTab}
          variant="scrollable"
        >
          <Tab label={t("inspector.response.tabs.overview")} value="overview" />
          {visibleTabs.includes("json") ? (
            <Tab label={t("inspector.response.tabs.json")} value="json" />
          ) : null}
          {visibleTabs.includes("jsonText") ? (
            <Tab label={t("inspector.response.tabs.jsonText")} value="jsonText" />
          ) : null}
          {visibleTabs.includes("text") ? (
            <Tab label={t("inspector.response.tabs.text")} value="text" />
          ) : null}
          {visibleTabs.includes("messages") ? (
            <Tab label={t("websocket.messagesTab")} value="messages" />
          ) : null}
          {visibleTabs.includes("headers") ? (
            <Tab label={buildCountTabLabel(t("inspector.response.tabs.headers"), detail?.responseHeaders.length ?? 0)} value="headers" />
          ) : null}
          {visibleTabs.includes("raw") ? (
            <Tab label={t("inspector.response.tabs.raw")} value="raw" />
          ) : null}
          {visibleTabs.includes("automation") ? (
            <Tab label={t("inspector.response.tabs.automation")} value="automation" />
          ) : null}
        </Tabs>

        {isSearchable ? (
          <Stack alignItems="center" direction="row" spacing={0.25}>
            <Tooltip arrow title={isSearchOpen ? t("inspector.response.actions.closeSearch") : t("inspector.response.actions.openSearch")}>
              <IconButton
                aria-label={isSearchOpen ? t("inspector.response.actions.closeSearch") : t("inspector.response.actions.openSearch")}
                onClick={() => {
                  if (isSearchOpen) {
                    closeSearch();
                    return;
                  }
                  setIsSearchOpen(true);
                }}
                size="small"
                sx={{ p: 0.75, color: isSearchOpen ? "primary.main" : undefined }}
              >
                <SearchRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip arrow title={t("inspector.response.actions.copyContent")}>
              <span>
                <IconButton
                  aria-label={t("inspector.response.actions.copyContent")}
                  disabled={!copyValue}
                  onClick={() => {
                    void handleCopy();
                  }}
                  size="small"
                  sx={{ p: 0.75 }}
                >
                  <ContentCopyRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        ) : null}
      </Box>

      <Divider />

      <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", p: 2.5 }}>
        <ResponseTabContent
          detail={detail}
          isResponseBodyLoading={isResponseBodyLoading}
          isResponseRawLoading={isResponseRawLoading}
          responseJsonDisplayText={responseJsonDisplayText}
          responseJsonResult={responseJsonResult}
          responseTab={activeResponseTab}
          searchMatcher={isSearchOpen ? searchController.matcher : null}
          currentMatchIndex={isSearchOpen ? searchController.currentMatchIndex : undefined}
          onMatchCountChange={isSearchOpen ? searchController.setMatchCount : undefined}
          session={session}
        />
      </Box>

      {isSearchOpen ? (
        <Box
          sx={{
            maxWidth: "calc(100% - 16px)",
            position: "absolute",
            right: 8,
            top: 38,
            zIndex: 2,
          }}
        >
          <SearchBar
            currentMatchIndex={searchController.currentMatchIndex}
            matchCount={searchController.matchCount}
            onClose={closeSearch}
            onNext={searchController.onNext}
            onOptionsChange={searchController.onOptionsChange}
            onPrevious={searchController.onPrevious}
            onQueryChange={searchController.onQueryChange}
            options={searchController.options}
            placeholder={searchPlaceholder}
            query={searchController.query}
            regexInvalid={searchController.isRegexInvalid}
          />
        </Box>
      ) : null}

      <Snackbar
        autoHideDuration={1800}
        message={t("contextMenu.copiedToClipboard")}
        onClose={() => setSnackbarOpen(false)}
        open={snackbarOpen}
      />
    </Stack>
  );
});

function ResponseTabContent({
  detail,
  isResponseBodyLoading,
  isResponseRawLoading,
  responseJsonDisplayText,
  responseJsonResult,
  responseTab,
  searchMatcher,
  currentMatchIndex,
  onMatchCountChange,
  session,
}: {
  detail: SessionDetail | undefined;
  isResponseBodyLoading: boolean;
  isResponseRawLoading: boolean;
  responseJsonDisplayText: string | undefined;
  responseJsonResult: JsonParseResult;
  responseTab: ResponseInspectorTab;
  searchMatcher: SearchMatcher | null;
  currentMatchIndex: number | undefined;
  onMatchCountChange: ((count: number) => void) | undefined;
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
      <SessionInspectorOverview
        detail={detail}
        session={session}
      />
    );
  }

  if (responseTab === "messages") {
    return <SessionInspectorMessagesPane sessionId={session.id} />;
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

  if (responseTab === "automation") {
    return <SessionInspectorAutomationPane sessionId={session.id} />;
  }

  if (responseTab === "raw") {
    const rawResponseText = getRawMessageText(detail?.rawResponse, detail?.rawResponseHead, detail?.responseBody);

    if (isResponseRawLoading && detail?.rawResponseDeferred) {
      return (
        <InspectorScrollArea>
          <Typography color="text.secondary" variant="body2">
            {t("inspector.workspace.loading")}
          </Typography>
        </InspectorScrollArea>
      );
    }

    return (
      <SearchableCodeBlock
        code={rawResponseText ?? t("inspector.response.rawUnavailable")}
        currentMatchIndex={currentMatchIndex}
        matcher={searchMatcher}
        onMatchCountChange={onMatchCountChange}
        searchQuery=""
      />
    );
  }

  if (responseTab === "json") {
    if (isResponseBodyLoading && detail?.responseBody?.textDeferred) {
      return (
        <InspectorScrollArea>
          <Typography color="text.secondary" variant="body2">
            {t("inspector.workspace.loading")}
          </Typography>
        </InspectorScrollArea>
      );
    }

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

    return (
      <SessionInspectorJsonTree
        currentMatchIndex={currentMatchIndex}
        matcher={searchMatcher}
        onMatchCountChange={onMatchCountChange}
        searchQuery=""
        value={responseJsonResult.value}
      />
    );
  }

  if (responseTab === "jsonText") {
    if (isResponseBodyLoading && detail?.responseBody?.textDeferred) {
      return (
        <InspectorScrollArea>
          <Typography color="text.secondary" variant="body2">
            {t("inspector.workspace.loading")}
          </Typography>
        </InspectorScrollArea>
      );
    }

    if (responseJsonResult.status === "tooLarge") {
      return (
        <Stack spacing={1.5}>
          <Alert severity="info">{responseJsonResult.message}</Alert>
          <SearchableCodeBlock
            code={getBodyText(detail?.responseBody) ?? t("composePage.responseNoBody")}
            currentMatchIndex={currentMatchIndex}
            language="json"
            matcher={searchMatcher}
            onMatchCountChange={onMatchCountChange}
            searchQuery=""
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
        currentMatchIndex={currentMatchIndex}
        language="json"
        matcher={searchMatcher}
        onMatchCountChange={onMatchCountChange}
        searchQuery=""
      />
    );
  }

  return (
    <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
      <Typography color="text.secondary" variant="caption">
        {bodyDescription ?? t("common.tech.noBodyCaptured")}
      </Typography>
      {isResponseBodyLoading && detail?.responseBody?.textDeferred ? (
        <Typography color="text.secondary" variant="body2">
          {t("inspector.workspace.loading")}
        </Typography>
      ) : (
        <SearchableCodeBlock
          code={getBodyText(detail?.responseBody) ?? t("inspector.response.noTextBody")}
          currentMatchIndex={currentMatchIndex}
          matcher={searchMatcher}
          onMatchCountChange={onMatchCountChange}
          searchQuery=""
        />
      )}
    </Stack>
  );
}
