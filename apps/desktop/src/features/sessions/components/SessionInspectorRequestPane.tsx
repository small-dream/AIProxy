import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, Button, Chip, Divider, OutlinedInput, Stack, Tab, Tabs, Typography } from "@mui/material";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { SessionDetail, SessionSummary } from "@pharles/shared-types";

import { useI18n } from "@/i18n";
import { InspectorDefinitionList, InspectorKeyValueTable, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  describeBody,
  getMethodColor,
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
    <Stack minHeight={0} spacing={0} sx={{ overflow: "hidden" }}>
      <Stack spacing={0.5} sx={{ px: 1.5, py: 1 }}>
        <Stack alignItems="center" direction="row" justifyContent="space-between" spacing={1}>
          <Typography variant="subtitle2">{t("inspector.request.sectionTitle")}</Typography>
          <Button
            onClick={() => onRequestCollapsedChange(!requestCollapsed)}
            size="small"
            startIcon={requestCollapsed ? <ExpandMoreRoundedIcon /> : <ExpandLessRoundedIcon />}
            sx={{ minWidth: 0, px: 1.25 }}
            variant="text"
          >
            {requestCollapsed ? t("common.actions.expand") : t("common.actions.collapse")}
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
            <Tab label={t("inspector.request.tabs.overview")} value="overview" />
            <Tab label={buildCountTabLabel(t("inspector.request.tabs.query"), detail?.queryParams.length ?? 0)} value="query" />
            <Tab label={buildCountTabLabel(t("inspector.request.tabs.headers"), detail?.requestHeaders.length ?? 0)} value="headers" />
            <Tab label={t("inspector.request.tabs.body")} value="body" />
            <Tab label={buildCountTabLabel(t("inspector.request.tabs.form"), requestFormEntries.length)} value="form" />
            <Tab label={t("inspector.request.tabs.raw")} value="raw" />
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
            searchQuery={showSearch ? searchValue : ""}
            session={session}
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
  session,
}: {
  detail: SessionDetail | undefined;
  requestBodyDisplayText: string;
  requestFormEntries: Array<[string, string]>;
  requestTab: RequestInspectorTab;
  searchQuery: string;
  session: SessionSummary;
}) {
  const { t } = useI18n();
  const bodyDescription = describeBody(detail?.requestBody, {
    formatBytes: (value) => t("common.tech.bytes", { value }),
    truncatedPreviewLabel: t("common.tech.truncatedPreview"),
    unknownMimeTypeLabel: t("common.tech.unknownMimeType"),
  });

  if (requestTab === "overview") {
    return (
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
          <Chip color={getMethodColor(session.method)} label={session.method} size="small" />
        </Stack>
        <InspectorDefinitionList
          items={[
            [t("common.labels.host"), session.host],
            [t("common.labels.path"), session.path || "/"],
            [t("common.labels.protocol"), session.protocol],
            [t("common.labels.url"), session.url],
            [t("common.labels.started"), session.startedAt],
            [t("common.labels.finished"), session.finishedAt],
            [t("common.labels.body"), bodyDescription ?? t("inspector.request.noBodyCaptured")],
          ]}
        />
        <Stack spacing={1}>
          <Typography variant="subtitle2">{t("inspector.cookies")}</Typography>
          <InspectorDefinitionList
            emptyMessage={t("inspector.request.cookiesEmpty")}
            items={detail?.cookies.map((entry) => [entry.name, entry.value]) ?? []}
          />
        </Stack>
      </Stack>
    );
  }

  if (requestTab === "query") {
    return (
      <InspectorKeyValueTable
        emptyMessage={t("inspector.request.emptyQuery")}
        items={detail?.queryParams.map((entry) => [entry.name, entry.value]) ?? []}
      />
    );
  }

  if (requestTab === "headers") {
    return (
      <InspectorKeyValueTable
        emptyMessage={t("inspector.request.emptyHeaders")}
        items={detail?.requestHeaders.map((entry) => [entry.name, entry.value]) ?? []}
      />
    );
  }

  if (requestTab === "form") {
    return (
      <Stack spacing={1}>
        <Typography color="text.secondary" variant="caption">
          {bodyDescription ?? t("common.tech.noBodyCaptured")}
        </Typography>
        <InspectorDefinitionList
          emptyMessage={t("inspector.request.emptyForm")}
          items={requestFormEntries}
        />
      </Stack>
    );
  }

  if (requestTab === "raw") {
    return <SearchableCodeBlock code={detail?.rawRequest ?? t("inspector.request.rawUnavailable")} searchQuery={searchQuery} />;
  }

  return (
    <Stack spacing={1}>
      <Typography color="text.secondary" variant="caption">
        {bodyDescription ?? t("common.tech.noBodyCaptured")}
      </Typography>
      <SearchableCodeBlock code={requestBodyDisplayText} searchQuery={searchQuery} />
    </Stack>
  );
}
