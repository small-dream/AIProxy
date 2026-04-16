import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, Button, Divider, OutlinedInput, Stack, Tab, Tabs, Typography } from "@mui/material";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { InspectorDefinitionList, InspectorKeyValueTable, InspectorScrollArea, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  describeBody,
  type RequestInspectorTab,
} from "./session-inspector.helpers";

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
  const [searchValue, setSearchValue] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const searchableTabs: ReadonlySet<RequestInspectorTab> = new Set(["body", "raw"]);
  const isSearchable = searchableTabs.has(requestTab);

  useEffect(() => {
    setSearchValue("");
    setShowSearch(false);
  }, [session.id]);

  useEffect(() => {
    if (!isSearchable) {
      setSearchValue("");
      setShowSearch(false);
    }
  }, [isSearchable]);

  const activateSearch = useCallback(() => {
    if (!isSearchable) return;
    setShowSearch(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [isSearchable]);

  useImperativeHandle(ref, () => ({ activateSearch }), [activateSearch]);

  return (
    <Stack minHeight={0} spacing={0} sx={{ height: "100%", overflow: "hidden", width: "100%" }}>
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

      {requestCollapsed ? null : (
        <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", p: 2 }}>
          <RequestTabContent
            detail={detail}
            requestBodyDisplayText={requestBodyDisplayText}
            requestFormEntries={requestFormEntries}
            requestTab={requestTab}
            searchQuery={showSearch ? searchValue : ""}
          />
        </Box>
      )}

      {showSearch && !requestCollapsed ? (
        <>
          <Divider />
          <Box sx={{ p: 1.5 }}>
            <OutlinedInput
              fullWidth
              inputRef={searchInputRef}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder={t("inspector.request.searchPlaceholder")}
              size="small"
              startAdornment={<SearchRoundedIcon fontSize="small" sx={{ mr: 1 }} />}
              value={searchValue}
            />
          </Box>
        </>
      ) : null}
    </Stack>
  );
});

function RequestTabContent({
  detail,
  requestBodyDisplayText,
  requestFormEntries,
  requestTab,
  searchQuery,
}: {
  detail: SessionDetail | undefined;
  requestBodyDisplayText: string;
  requestFormEntries: Array<[string, string]>;
  requestTab: RequestInspectorTab;
  searchQuery: string;
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
    return <SearchableCodeBlock code={detail?.rawRequest ?? t("inspector.request.rawUnavailable")} searchQuery={searchQuery} />;
  }

  return (
    <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
      <Typography color="text.secondary" variant="caption">
        {bodyDescription ?? t("common.tech.noBodyCaptured")}
      </Typography>
      <SearchableCodeBlock code={requestBodyDisplayText} searchQuery={searchQuery} />
    </Stack>
  );
}
