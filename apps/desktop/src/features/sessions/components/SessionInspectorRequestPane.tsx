import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, Button, Divider, Stack, Tab, Tabs, Typography } from "@mui/material";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { InspectorDefinitionList, InspectorKeyValueTable, InspectorScrollArea, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  describeBody,
  type RequestInspectorTab,
  type SearchMatcher,
} from "./session-inspector.helpers";
import { SearchBar } from "./SearchBar";
import { useSearchController } from "./use-search-controller";

export type RequestPaneHandle = {
  activateSearch: () => void;
};

export const SessionInspectorRequestPane = forwardRef<RequestPaneHandle, {
  detail: SessionDetail | undefined;
  onRequestCollapsedChange: (collapsed: boolean) => void;
  onRequestTabChange: (tab: RequestInspectorTab) => void;
  requestBodyDisplayText: string;
  requestCollapsed: boolean;
  requestFormEntries: Array<[string, string]>;
  requestTab: RequestInspectorTab;
  session: SessionSummary;
}>(function SessionInspectorRequestPane({
  detail,
  onRequestCollapsedChange,
  onRequestTabChange,
  requestBodyDisplayText,
  requestCollapsed,
  requestFormEntries,
  requestTab,
  session,
}, ref) {
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

  return (
    <Stack minHeight={0} spacing={0} sx={{ height: "100%", overflow: "hidden", position: "relative", width: "100%" }}>
      <Box sx={{ alignItems: "center", bgcolor: "background.paper", display: "flex", minHeight: 32, pr: 0.5 }}>
        <Tabs
          onChange={(_event, nextTab) => onRequestTabChange(nextTab as RequestInspectorTab)}
          scrollButtons="auto"
          sx={{ flex: 1, minHeight: 32, minWidth: 0, px: 0.5 }}
          value={requestTab}
          variant="scrollable"
        >
          <Tab label={buildCountTabLabel(t("inspector.request.tabs.query"), detail?.queryParams.length ?? 0)} value="query" />
          <Tab label={buildCountTabLabel(t("inspector.request.tabs.headers"), detail?.requestHeaders.length ?? 0)} value="headers" />
          <Tab label={t("inspector.request.tabs.body")} value="body" />
          <Tab label={buildCountTabLabel(t("inspector.request.tabs.form"), requestFormEntries.length)} value="form" />
          <Tab label={t("inspector.request.tabs.raw")} value="raw" />
        </Tabs>
        <Button
          onClick={() => onRequestCollapsedChange(!requestCollapsed)}
          size="small"
          startIcon={requestCollapsed ? <ExpandMoreRoundedIcon /> : <ExpandLessRoundedIcon />}
          sx={{ minWidth: 0, px: 1.25 }}
          variant="text"
        >
          {requestCollapsed ? t("common.actions.expand") : t("common.actions.collapse")}
        </Button>
      </Box>

      <Divider />

      {requestCollapsed ? null : (
        <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", p: 2.5 }}>
          <RequestTabContent
            detail={detail}
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
  requestBodyDisplayText,
  requestFormEntries,
  requestTab,
  searchMatcher,
  currentMatchIndex,
  onMatchCountChange,
}: {
  detail: SessionDetail | undefined;
  requestBodyDisplayText: string;
  requestFormEntries: Array<[string, string]>;
  requestTab: RequestInspectorTab;
  searchMatcher: SearchMatcher | null;
  currentMatchIndex: number | undefined;
  onMatchCountChange: ((count: number) => void) | undefined;
}) {
  const { t } = useI18n();
  const bodyDescription = describeBody(detail?.requestBody, {
    formatBytes: (value) => t("common.tech.bytes", { value }),
    truncatedPreviewLabel: t("common.tech.truncatedPreview"),
    unknownMimeTypeLabel: t("common.tech.unknownMimeType"),
  });

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
          items={detail?.requestHeaders.map((entry) => [entry.name, entry.value]) ?? []}
        />
      </InspectorScrollArea>
    );
  }

  if (requestTab === "form") {
    return (
      <InspectorScrollArea>
        <Stack spacing={1}>
          <Typography color="text.secondary" variant="caption">
            {bodyDescription ?? t("common.tech.noBodyCaptured")}
          </Typography>
          <InspectorDefinitionList
            emptyMessage={t("inspector.request.emptyForm")}
            items={requestFormEntries}
          />
        </Stack>
      </InspectorScrollArea>
    );
  }

  if (requestTab === "raw") {
    return (
      <SearchableCodeBlock
        code={detail?.rawRequest ?? t("inspector.request.rawUnavailable")}
        currentMatchIndex={currentMatchIndex}
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
        code={requestBodyDisplayText}
        currentMatchIndex={currentMatchIndex}
        matcher={searchMatcher}
        onMatchCountChange={onMatchCountChange}
        searchQuery=""
      />
    </Stack>
  );
}
