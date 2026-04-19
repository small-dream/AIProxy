import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Alert, Box, Divider, IconButton, Snackbar, Stack, Tab, Tabs, Tooltip, Typography } from "@mui/material";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { SessionInspectorJsonTree } from "./SessionInspectorJsonTree";
import { SessionInspectorMessagesPane } from "./SessionInspectorMessagesPane";
import { SessionInspectorOverview } from "./SessionInspectorOverview";
import { InspectorKeyValueTable, InspectorScrollArea, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  describeBody,
  getBodyText,
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
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const searchController = useSearchController();
  const isSearchable = SEARCHABLE_TABS.has(responseTab);

  useEffect(() => {
    setIsSearchOpen(false);
    setSnackbarOpen(false);

    if (isWebSocketSession(session)) {
      if (responseTab === "text" || responseTab === "json" || responseTab === "jsonText") {
        onResponseTabChange("overview");
      }
    } else if (responseTab === "messages") {
      onResponseTabChange("overview");
    }
    // Only reset when the session itself changes, not on every render of responseTab/session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

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
    responseTab === "json" ? t("inspector.response.jsonSearchPlaceholder") :
    responseTab === "jsonText" ? t("inspector.response.jsonTextSearchPlaceholder") :
    responseTab === "raw" ? t("inspector.response.rawSearchPlaceholder") :
    t("inspector.response.rawSearchPlaceholder");
  const copyValue = useMemo(() => {
    if (responseTab === "json" || responseTab === "jsonText") {
      return responseJsonDisplayText ?? getBodyText(detail?.responseBody) ?? "";
    }

    if (responseTab === "raw") {
      return detail?.rawResponse ?? "";
    }

    if (responseTab === "text") {
      return getBodyText(detail?.responseBody) ?? "";
    }

    return "";
  }, [detail?.rawResponse, detail?.responseBody, responseJsonDisplayText, responseTab]);

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
          value={responseTab}
          variant="scrollable"
        >
          <Tab label={t("inspector.response.tabs.overview")} value="overview" />
          <Tab label={buildCountTabLabel(t("inspector.response.tabs.headers"), detail?.responseHeaders.length ?? 0)} value="headers" />
          {isWebSocketSession(session) && (
            <Tab label={t("websocket.messagesTab")} value="messages" />
          )}
          {!isWebSocketSession(session) && [
            <Tab key="text" label={t("inspector.response.tabs.text")} value="text" />,
            <Tab key="json" label={t("inspector.response.tabs.json")} value="json" />,
            <Tab key="jsonText" label={t("inspector.response.tabs.jsonText")} value="jsonText" />,
          ]}
          <Tab label={t("inspector.response.tabs.raw")} value="raw" />
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
          responseJsonDisplayText={responseJsonDisplayText}
          responseJsonResult={responseJsonResult}
          responseTab={responseTab}
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
  responseJsonDisplayText,
  responseJsonResult,
  responseTab,
  searchMatcher,
  currentMatchIndex,
  onMatchCountChange,
  session,
}: {
  detail: SessionDetail | undefined;
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

  if (responseTab === "raw") {
    return (
      <SearchableCodeBlock
        code={detail?.rawResponse ?? t("inspector.response.rawUnavailable")}
        currentMatchIndex={currentMatchIndex}
        matcher={searchMatcher}
        onMatchCountChange={onMatchCountChange}
        searchQuery=""
      />
    );
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
      <SearchableCodeBlock
        code={getBodyText(detail?.responseBody) ?? t("inspector.response.noTextBody")}
        currentMatchIndex={currentMatchIndex}
        matcher={searchMatcher}
        onMatchCountChange={onMatchCountChange}
        searchQuery=""
      />
    </Stack>
  );
}
