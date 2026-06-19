import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Alert, Box, Button, Divider, Stack, Tab, Tabs, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import {
  EllipsizedCell,
  InspectorFlatTable,
  InspectorFlatTableRow,
  InspectorKeyValueTable,
  InspectorScrollArea,
  SearchableCodeBlock,
  inspectorPaneActionButtonSx,
  inspectorTabsSx,
} from "./SessionInspectorShared";
import {
  getBodyCodeLanguage,
  getRawMessageText,
  type RequestFormEntry,
  type RequestInspectorTab,
  type SearchMatcher,
} from "./session-inspector.helpers";
import { SearchBar } from "./SearchBar";
import { useSearchController } from "./use-search-controller";

export type RequestPaneHandle = {
  activateSearch: () => void;
};

export const SessionInspectorRequestPane = forwardRef<
  RequestPaneHandle,
  {
    detail: SessionDetail | undefined;
    isRequestBodyLoading: boolean;
    isRequestFormLoading: boolean;
    isRequestRawLoading: boolean;
    onRequestCollapsedChange: (collapsed: boolean) => void;
    onRequestTabChange: (tab: RequestInspectorTab) => void;
    requestBodyDisplayText: string;
    requestCollapsed: boolean;
    requestFormEntries: RequestFormEntry[];
    requestTab: RequestInspectorTab;
    session: SessionSummary;
  }
>(function SessionInspectorRequestPane(
  {
    detail,
    isRequestBodyLoading,
    isRequestFormLoading,
    isRequestRawLoading,
    onRequestCollapsedChange,
    onRequestTabChange,
    requestBodyDisplayText,
    requestCollapsed,
    requestFormEntries,
    requestTab,
    session,
  },
  ref,
) {
  const { t } = useI18n();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchController = useSearchController();

  const searchableTabs: ReadonlySet<RequestInspectorTab> = new Set(["body", "raw"]);
  const isSearchable = searchableTabs.has(requestTab);

  useEffect(() => {
    setIsSearchOpen(false);
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

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    searchController.onQueryChange("");
  }, [searchController]);

  const handleSearchWithText = useCallback(
    (text: string) => {
      setIsSearchOpen(true);
      searchController.onQueryChange(text);
    },
    [searchController],
  );

  return (
    <Stack
      spacing={0}
      sx={{
        minHeight: 0,
        height: "100%",
        overflow: "hidden",
        position: "relative",
        width: "100%"
      }}>
      <Box
        sx={(theme) => ({
          alignItems: "center",
          bgcolor: alpha(
            theme.palette.background.paper,
            theme.palette.mode === "dark" ? 0.72 : 0.86,
          ),
          display: "flex",
          minHeight: 40,
          pr: 0.75,
        })}
      >
        <Tabs
          onChange={(_event, nextTab) => onRequestTabChange(nextTab as RequestInspectorTab)}
          scrollButtons="auto"
          sx={inspectorTabsSx}
          value={requestTab}
          variant="scrollable"
        >
          <Tab label={t("inspector.request.tabs.query")} value="query" />
          <Tab label={t("inspector.request.tabs.form")} value="form" />
          <Tab label={t("inspector.request.tabs.body")} value="body" />
          <Tab label={t("inspector.request.tabs.headers")} value="headers" />
          <Tab label={t("inspector.request.tabs.raw")} value="raw" />
        </Tabs>
        <Button
          onClick={() => onRequestCollapsedChange(!requestCollapsed)}
          size="small"
          startIcon={requestCollapsed ? <ExpandMoreRoundedIcon /> : <ExpandLessRoundedIcon />}
          sx={inspectorPaneActionButtonSx}
          variant="text"
        >
          {requestCollapsed ? t("common.actions.expand") : t("common.actions.collapse")}
        </Button>
      </Box>
      <Divider />
      {requestCollapsed ? null : (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            pl: 2,
            pr: 0.5,
            pb: 2,
            pt: 1.5,
          }}
        >
          {detail?.requestBody?.truncated && (
            <Alert severity="warning" sx={{ mx: 1, mb: 1 }}>
              {t("inspector.sessionInspector.bodyTruncatedWarning")}
            </Alert>
          )}
          <RequestTabContent
            detail={detail}
            isRequestBodyLoading={isRequestBodyLoading}
            isRequestFormLoading={isRequestFormLoading}
            isRequestRawLoading={isRequestRawLoading}
            onSearchWithText={handleSearchWithText}
            requestBodyDisplayText={requestBodyDisplayText}
            requestFormEntries={requestFormEntries}
            requestTab={requestTab}
            searchMatcher={isSearchOpen ? searchController.matcher : null}
            currentMatchIndex={isSearchOpen ? searchController.currentMatchIndex : undefined}
            onMatchCountChange={isSearchOpen ? searchController.setMatchCount : undefined}
          />
        </Box>
      )}
      {isSearchOpen && !requestCollapsed ? (
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
            placeholder={t("inspector.request.searchPlaceholder")}
            query={searchController.query}
            regexInvalid={searchController.isRegexInvalid}
          />
        </Box>
      ) : null}
    </Stack>
  );
});

function RequestTabContent({
  detail,
  isRequestBodyLoading,
  isRequestFormLoading,
  isRequestRawLoading,
  onSearchWithText,
  requestBodyDisplayText,
  requestFormEntries,
  requestTab,
  searchMatcher,
  currentMatchIndex,
  onMatchCountChange,
}: {
  detail: SessionDetail | undefined;
  isRequestBodyLoading: boolean;
  isRequestFormLoading: boolean;
  isRequestRawLoading: boolean;
  onSearchWithText?: ((text: string) => void) | undefined;
  requestBodyDisplayText: string;
  requestFormEntries: RequestFormEntry[];
  requestTab: RequestInspectorTab;
  searchMatcher: SearchMatcher | null;
  currentMatchIndex: number | undefined;
  onMatchCountChange: ((count: number) => void) | undefined;
}) {
  const { t } = useI18n();
  const requestBodyLanguage = getBodyCodeLanguage(detail?.requestBody, requestBodyDisplayText);

  if (requestTab === "query") {
    return (
      <InspectorScrollArea>
        <InspectorKeyValueTable
          emptyMessage={t("inspector.request.emptyQuery")}
          items={detail?.queryParams.map((entry) => [entry.name, entry.value]) ?? []}
        />
      </InspectorScrollArea>
    );
  }

  if (requestTab === "headers") {
    return (
      <InspectorScrollArea>
        <InspectorKeyValueTable
          emptyMessage={t("inspector.request.emptyHeaders")}
          items={
            detail?.requestHeaders.map((entry) => ({
              name: entry.name,
              value: entry.value,
              isPseudo: entry.isPseudo,
            })) ?? []
          }
          title={t("inspector.request.headersTitle")}
        />
      </InspectorScrollArea>
    );
  }

  if (requestTab === "form") {
    const isMultipartForm = (detail?.requestBody?.mimeType?.toLowerCase() ?? "").includes(
      "multipart/form-data",
    );

    if (
      isRequestFormLoading &&
      (detail?.requestBody?.textDeferred || detail?.requestBody?.base64Deferred)
    ) {
      return (
        <InspectorScrollArea>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("inspector.workspace.loading")}
          </Typography>
        </InspectorScrollArea>
      );
    }

    return (
      <InspectorScrollArea>
        <Stack spacing={1}>
          {isMultipartForm ? (
            <MultipartFormTable
              emptyMessage={t("inspector.request.emptyForm")}
              entries={requestFormEntries}
            />
          ) : (
            <InspectorKeyValueTable
              emptyMessage={t("inspector.request.emptyForm")}
              items={requestFormEntries
                .filter(
                  (entry): entry is Extract<RequestFormEntry, { kind: "field" }> =>
                    entry.kind === "field",
                )
                .map((entry) => [entry.name, entry.value])}
            />
          )}
        </Stack>
      </InspectorScrollArea>
    );
  }

  if (requestTab === "raw") {
    const rawRequestText = getRawMessageText(
      detail?.rawRequest,
      detail?.rawRequestHead,
      detail?.requestBody,
    );

    if (isRequestRawLoading && detail?.rawRequestDeferred) {
      return (
        <InspectorScrollArea>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("inspector.workspace.loading")}
          </Typography>
        </InspectorScrollArea>
      );
    }

    return (
      <SearchableCodeBlock
        code={rawRequestText ?? t("inspector.request.rawUnavailable")}
        currentMatchIndex={currentMatchIndex}
        matcher={searchMatcher}
        onMatchCountChange={onMatchCountChange}
        onSearchWithText={onSearchWithText}
        searchQuery=""
      />
    );
  }

  return (
    <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
      {isRequestBodyLoading && detail?.requestBody?.textDeferred ? (
        <Typography variant="body2" sx={{
          color: "text.secondary"
        }}>
          {t("inspector.workspace.loading")}
        </Typography>
      ) : (
        <SearchableCodeBlock
          code={requestBodyDisplayText}
          currentMatchIndex={currentMatchIndex}
          language={requestBodyLanguage}
          matcher={searchMatcher}
          onMatchCountChange={onMatchCountChange}
          onSearchWithText={onSearchWithText}
          searchQuery=""
        />
      )}
    </Stack>
  );
}

function MultipartFormTable({
  emptyMessage,
  entries,
}: {
  emptyMessage: string;
  entries: RequestFormEntry[];
}) {
  const { t } = useI18n();

  if (entries.length === 0) {
    return (
      <Typography variant="body2" sx={{
        color: "text.secondary"
      }}>
        {emptyMessage}
      </Typography>
    );
  }

  const columnTemplate =
    "minmax(156px, 0.95fr) minmax(180px, 1.2fr) minmax(180px, 1.1fr) minmax(180px, 1.15fr)";

  return (
    <InspectorFlatTable columnTemplate={columnTemplate}>
      {entries.map((entry, index) => (
        <InspectorFlatTableRow
          cells={[
            <EllipsizedCell key="name" text={entry.name} />,
            <EllipsizedCell key="contentType" text={entry.contentType ?? ""} />,
            <EllipsizedCell key="filename" text={entry.kind === "file" ? entry.filename : ""} />,
            <EllipsizedCell
              key="value"
              text={
                entry.kind === "file" ? formatMultipartFileSize(entry.sizeBytes, t) : entry.value
              }
            />,
          ]}
          columnTemplate={columnTemplate}
          dense
          hoverable
          key={`${entry.kind}:${entry.name}:${index}`}
        />
      ))}
    </InspectorFlatTable>
  );
}

function formatMultipartFileSize(sizeBytes: number, t: ReturnType<typeof useI18n>["t"]) {
  return `${formatCompactBytes(sizeBytes)} (${t("common.tech.bytes", { value: sizeBytes })})`;
}

function formatCompactBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(2)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}
