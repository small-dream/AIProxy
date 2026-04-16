import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Alert, Box, Divider, IconButton, OutlinedInput, Popover, Snackbar, Stack, Tab, Tabs, Tooltip, Typography } from "@mui/material";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { SessionInspectorJsonTree } from "./SessionInspectorJsonTree";
import { SessionInspectorOverview } from "./SessionInspectorOverview";
import { InspectorKeyValueTable, InspectorScrollArea, SearchableCodeBlock } from "./SessionInspectorShared";
import {
  buildCountTabLabel,
  describeBody,
  getBodyText,
  type JsonParseResult,
  type ResponseInspectorTab,
} from "./session-inspector.helpers";

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
  const [searchValue, setSearchValue] = useState("");
  const [searchAnchorEl, setSearchAnchorEl] = useState<HTMLElement | null>(null);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const isSearchable = SEARCHABLE_TABS.has(responseTab);
  const searchPopoverOpen = Boolean(searchAnchorEl);

  useEffect(() => {
    setSearchValue("");
    setSearchAnchorEl(null);
    setSnackbarOpen(false);
  }, [session.id]);

  useEffect(() => {
    if (!isSearchable) {
      setSearchValue("");
      setSearchAnchorEl(null);
    }
  }, [isSearchable]);

  const openSearchPopover = useCallback((anchor: HTMLElement | null) => {
    if (!isSearchable || !anchor) return;
    setSearchAnchorEl(anchor);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [isSearchable]);

  const closeSearchPopover = useCallback(() => {
    setSearchAnchorEl(null);
    setSearchValue("");
  }, []);

  const activateSearch = useCallback(() => {
    if (!isSearchable) return;
    openSearchPopover(searchButtonRef.current);
  }, [isSearchable, openSearchPopover]);

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

  return (
    <Stack minHeight={0} spacing={0} sx={{ height: "100%", overflow: "hidden", width: "100%" }}>

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
          <Tab label={t("inspector.response.tabs.text")} value="text" />
          <Tab label={t("inspector.response.tabs.json")} value="json" />
          <Tab label={t("inspector.response.tabs.jsonText")} value="jsonText" />
          <Tab label={t("inspector.response.tabs.raw")} value="raw" />
        </Tabs>

        {isSearchable ? (
          <Stack alignItems="center" direction="row" spacing={0.25}>
            <Tooltip arrow title={searchPopoverOpen ? t("inspector.response.actions.closeSearch") : t("inspector.response.actions.openSearch")}>
              <IconButton
                aria-label={searchPopoverOpen ? t("inspector.response.actions.closeSearch") : t("inspector.response.actions.openSearch")}
                onClick={(event) => {
                  if (searchPopoverOpen) {
                    closeSearchPopover();
                    return;
                  }
                  openSearchPopover(event.currentTarget);
                }}
                ref={searchButtonRef}
                size="small"
                sx={{ p: 0.75 }}
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

      <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", p: 2 }}>
        <ResponseTabContent
          detail={detail}
          responseJsonDisplayText={responseJsonDisplayText}
          responseJsonResult={responseJsonResult}
          responseTab={responseTab}
          searchValue={searchPopoverOpen ? searchValue : ""}
          session={session}
        />
      </Box>

      <Popover
        anchorEl={searchAnchorEl}
        anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
        onClose={closeSearchPopover}
        open={searchPopoverOpen}
        slotProps={{
          paper: {
            sx: {
              border: 1,
              borderColor: "divider",
              boxShadow: 8,
              mt: 0.75,
              overflow: "hidden",
            },
          },
        }}
        transformOrigin={{ horizontal: "right", vertical: "top" }}
      >
        <Stack alignItems="center" direction="row" spacing={1} sx={{ p: 1 }}>
          <OutlinedInput
            autoFocus
            inputRef={searchInputRef}
            onChange={(event) => setSearchValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearchPopover();
              }
            }}
            placeholder={searchPlaceholder}
            size="small"
            startAdornment={<SearchRoundedIcon fontSize="small" sx={{ mr: 1 }} />}
            sx={{ minWidth: 280 }}
            value={searchValue}
          />
          <Tooltip arrow title={t("inspector.response.actions.closeSearch")}>
            <IconButton
              aria-label={t("inspector.response.actions.closeSearch")}
              onClick={closeSearchPopover}
              size="small"
              sx={{ p: 0.75 }}
            >
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Popover>

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
  searchValue,
  session,
}: {
  detail: SessionDetail | undefined;
  responseJsonDisplayText: string | undefined;
  responseJsonResult: JsonParseResult;
  responseTab: ResponseInspectorTab;
  searchValue: string;
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
    return <SearchableCodeBlock code={detail?.rawResponse ?? t("inspector.response.rawUnavailable")} searchQuery={searchValue} />;
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

    return <SessionInspectorJsonTree searchQuery={searchValue} value={responseJsonResult.value} />;
  }

  if (responseTab === "jsonText") {
    if (responseJsonResult.status === "tooLarge") {
      return (
        <Stack spacing={1.5}>
          <Alert severity="info">{responseJsonResult.message}</Alert>
          <SearchableCodeBlock
            code={getBodyText(detail?.responseBody) ?? t("composePage.responseNoBody")}
            language="json"
            searchQuery={searchValue}
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
        language="json"
        searchQuery={searchValue}
      />
    );
  }

  return (
    <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
      <Typography color="text.secondary" variant="caption">
        {bodyDescription ?? t("common.tech.noBodyCaptured")}
      </Typography>
      <SearchableCodeBlock code={getBodyText(detail?.responseBody) ?? t("inspector.response.noTextBody")} searchQuery={searchValue} />
    </Stack>
  );
}
