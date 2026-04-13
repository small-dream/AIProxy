import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import { Alert, Box, CircularProgress, Divider, IconButton, MenuItem, OutlinedInput, Select, Snackbar, Stack, Tab, Tabs, TextField, Tooltip, Typography } from "@mui/material";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { generateCurlCommand } from "@/features/compose/curl-export";
import { useSendComposedRequest } from "@/features/compose/use-compose-request";
import { EditableKeyValueTable } from "@/features/compose/components/EditableKeyValueTable";
import { InspectorDefinitionList, InspectorKeyValueTable, SearchableCodeBlock } from "@/features/sessions/components/SessionInspectorShared";
import { SessionInspectorJsonTree } from "@/features/sessions/components/SessionInspectorJsonTree";
import { getBodyText, parseJsonBody, type JsonParseResult } from "@/features/sessions/components/session-inspector.helpers";
import { useI18n } from "@/i18n";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const COMPOSE_SPLIT_STORAGE_KEY = "pharles.compose.splitRatio";
const COMPOSE_SPLIT_MIN = 0.15;
const COMPOSE_SPLIT_MAX = 0.85;
const COMPOSE_SPLIT_DEFAULT = 0.45;

function clampSplitRatio(ratio: number): number {
  return Math.min(COMPOSE_SPLIT_MAX, Math.max(COMPOSE_SPLIT_MIN, ratio));
}

function readStorageValue(key: string): string | null {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return null;
  }
  return window.localStorage.getItem(key);
}

function writeStorageValue(key: string, value: string) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }
  window.localStorage.setItem(key, value);
}

export function ComposePage() {
  const { t } = useI18n();
  const sendMutation = useSendComposedRequest();

  const method = useComposeEditorStore((s) => s.method);
  const url = useComposeEditorStore((s) => s.url);
  const headers = useComposeEditorStore((s) => s.headers);
  const body = useComposeEditorStore((s) => s.body);
  const activeTab = useComposeEditorStore((s) => s.activeTab);
  const setMethod = useComposeEditorStore((s) => s.setMethod);
  const setUrl = useComposeEditorStore((s) => s.setUrl);
  const setHeaders = useComposeEditorStore((s) => s.setHeaders);
  const setBody = useComposeEditorStore((s) => s.setBody);
  const setActiveTab = useComposeEditorStore((s) => s.setActiveTab);

  const responseDetail = sendMutation.data;
  const [responseTab, setResponseTab] = useState<"overview" | "headers" | "json" | "jsonText" | "raw" | "timing">("overview");
  const [searchValue, setSearchValue] = useState("");
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [splitRatio, setSplitRatio] = useState(COMPOSE_SPLIT_DEFAULT);
  const dragFrameRef = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Load split ratio from localStorage
  useEffect(() => {
    const saved = readStorageValue(COMPOSE_SPLIT_STORAGE_KEY);
    const parsed = Number(saved);
    if (Number.isFinite(parsed)) {
      setSplitRatio(clampSplitRatio(parsed));
    }
  }, []);

  // Persist split ratio
  useEffect(() => {
    writeStorageValue(COMPOSE_SPLIT_STORAGE_KEY, String(splitRatio));
  }, [splitRatio]);

  // Cleanup animation frame
  useEffect(() => {
    return () => {
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
      }
    };
  }, []);

  const handleSend = useCallback(() => {
    sendMutation.mutate({
      workspaceId: "default",
      method,
      url,
      headers,
      ...(body ? { body } : {}),
    });
  }, [sendMutation, method, url, headers, body]);

  const handleExportCurl = useCallback(() => {
    const cmd = generateCurlCommand({ method, url, headers, ...(body ? { body } : {}) });
    void navigator.clipboard?.writeText(cmd);
    setSnackbarOpen(true);
  }, [method, url, headers, body]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    const container = gridRef.current;
    if (!container) return;

    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const updateRatio = (clientY: number) => {
      const bounds = container.getBoundingClientRect();
      const ratio = clampSplitRatio((clientY - bounds.top) / bounds.height);

      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
      }

      dragFrameRef.current = window.requestAnimationFrame(() => {
        setSplitRatio(ratio);
      });
    };

    updateRatio(event.clientY);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateRatio(moveEvent.clientY);
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  const responseBodyText = getBodyText(responseDetail?.responseBody);

  const responseJsonResult = useMemo<JsonParseResult>(() => {
    if (responseTab !== "json" && responseTab !== "jsonText") {
      return { status: "idle" };
    }
    return parseJsonBody(responseDetail?.responseBody, responseBodyText, {
      responseErrorMessage: t("inspector.jsonParse.responseError"),
      tooLargeMessage: t("inspector.jsonParse.tooLarge"),
    });
  }, [responseDetail?.responseBody, responseBodyText, responseTab, t]);

  const showSearch = responseTab === "json" || responseTab === "jsonText";

  const responseTabContent = (() => {
    if (!responseDetail) return null;

    switch (responseTab) {
      case "overview":
        return (
          <InspectorDefinitionList
            items={[
              [t("common.labels.status"), String(responseDetail.summary.statusCode)],
              [t("common.labels.duration"), t("common.tech.milliseconds", { value: responseDetail.summary.durationMs })],
              [t("common.labels.size"), t("common.tech.bytes", { value: responseDetail.summary.sizeBytes })],
              [t("composePage.responseBody"), responseDetail.responseBody ? t("common.tech.bytes", { value: responseDetail.responseBody.sizeBytes }) : t("common.tech.noBody")],
              [t("composePage.timingTotal"), responseDetail.timing?.totalMs != null ? t("common.tech.milliseconds", { value: responseDetail.timing.totalMs }) : t("common.states.notCaptured")],
            ]}
          />
        );
      case "headers":
        return (
          <InspectorKeyValueTable
            emptyMessage={t("composePage.responseHeadersEmpty")}
            items={responseDetail.responseHeaders.map((h) => [h.name, h.value])}
          />
        );
      case "json":
        if (responseJsonResult.status === "tooLarge") {
          return <Alert severity="info">{responseJsonResult.message}</Alert>;
        }
        if (responseJsonResult.status === "error") {
          return <Alert severity="warning">{responseJsonResult.message}</Alert>;
        }
        if (responseJsonResult.status === "idle") {
          return <Typography color="text.secondary" sx={{ py: 2 }} variant="body2">{t("composePage.responseNoBody")}</Typography>;
        }
        return <SessionInspectorJsonTree searchQuery={searchValue} value={responseJsonResult.value} />;
      case "jsonText":
        if (responseJsonResult.status === "tooLarge") {
          return (
            <Stack spacing={1.5}>
              <Alert severity="info">{responseJsonResult.message}</Alert>
              <SearchableCodeBlock code={responseBodyText ?? ""} language="plain" searchQuery={searchValue} />
            </Stack>
          );
        }
        if (responseJsonResult.status === "error") {
          return <Alert severity="warning">{responseJsonResult.message}</Alert>;
        }
        if (responseJsonResult.status === "success") {
          return <SearchableCodeBlock code={responseJsonResult.prettyText} language="json" searchQuery={searchValue} />;
        }
        return <Typography color="text.secondary" sx={{ py: 2 }} variant="body2">{t("composePage.responseNoBody")}</Typography>;
      case "raw":
        return (
          <SearchableCodeBlock
            code={responseDetail.rawResponse ?? t("composePage.responseNoBody")}
            language="plain"
            searchQuery=""
          />
        );
      case "timing": {
        const timing = responseDetail.timing;
        return (
          <InspectorDefinitionList
            items={[
              [t("composePage.dns"), timing?.dnsMs != null ? t("common.tech.milliseconds", { value: timing.dnsMs }) : t("common.states.notCaptured")],
              [t("composePage.connect"), timing?.connectMs != null ? t("common.tech.milliseconds", { value: timing.connectMs }) : t("common.states.notCaptured")],
              [t("composePage.tls"), timing?.tlsMs != null ? t("common.tech.milliseconds", { value: timing.tlsMs }) : t("common.states.notCaptured")],
              [t("composePage.requestSend"), timing?.requestSendMs != null ? t("common.tech.milliseconds", { value: timing.requestSendMs }) : t("common.states.notCaptured")],
              [t("composePage.waiting"), timing?.waitingMs != null ? t("common.tech.milliseconds", { value: timing.waitingMs }) : t("common.states.notCaptured")],
              [t("composePage.responseRead"), timing?.responseReadMs != null ? t("common.tech.milliseconds", { value: timing.responseReadMs }) : t("common.states.notCaptured")],
              [t("common.labels.total"), timing?.totalMs != null ? t("common.tech.milliseconds", { value: timing.totalMs }) : t("common.states.notCaptured")],
            ]}
          />
        );
      }
    }
  })();

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      {/* URL Bar Row */}
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", pb: 1.5 }}>
        <Select
          size="small"
          sx={{ flex: "0 0 120px", fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 13, fontWeight: 600 }}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          {HTTP_METHODS.map((m) => (
            <MenuItem key={m} sx={{ fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 13 }} value={m}>
              {m}
            </MenuItem>
          ))}
        </Select>
        <OutlinedInput
          fullWidth
          placeholder={t("composePage.urlPlaceholder")}
          size="small"
          sx={{ fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 13 }}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) handleSend();
          }}
        />
        <Tooltip title={t("common.actions.send")}>
          <span>
            <IconButton
              color="primary"
              disabled={!url.trim() || sendMutation.isPending}
              onClick={handleSend}
              size="small"
            >
              {sendMutation.isPending ? <CircularProgress size={20} color="inherit" /> : <SendRoundedIcon />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("composePage.copyAsCurl")}>
          <span>
            <IconButton
              color="primary"
              disabled={!url.trim()}
              onClick={handleExportCurl}
              size="small"
            >
              <ContentCopyRoundedIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Divider />

      {/* Main Split: Request / Response */}
      <Box
        ref={gridRef}
        sx={{
          display: "grid",
          flex: 1,
          gridTemplateRows: `${splitRatio}fr 8px ${1 - splitRatio}fr`,
          minHeight: 0,
          mt: 0.5,
        }}
      >
        {/* Request Section */}
        <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          <Tabs
            onChange={(_, value) => setActiveTab(value)}
            sx={{ minHeight: 32, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}
            TabIndicatorProps={{ sx: { height: 2 } }}
            value={activeTab}
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab label={`${t("composePage.tabs.headers")}${headers.length > 0 ? ` (${headers.length})` : ""}`} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="headers" />
            <Tab label={t("composePage.tabs.body")} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="body" />
            <Tab label={t("composePage.tabs.query")} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="query" />
          </Tabs>

          <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pt: 1.5, px: 0.5 }}>
            {activeTab === "headers" && (
              <EditableKeyValueTable
                items={headers}
                namePlaceholder={t("common.placeholders.headerName")}
                onChange={setHeaders}
                valuePlaceholder={t("common.placeholders.headerValue")}
              />
            )}

            {activeTab === "body" && (
              <TextField
                fullWidth
                minRows={6}
                multiline
                placeholder={t("composePage.bodyPlaceholder")}
                size="small"
                sx={{
                  fontFamily: "JetBrains Mono, Consolas, monospace",
                  "& .MuiInputBase-input": {
                    fontFamily: "JetBrains Mono, Consolas, monospace",
                    fontSize: 13,
                    lineHeight: 1.5,
                  },
                }}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            )}

            {activeTab === "query" && (
              <QueryParamsEditor
                namePlaceholder={t("common.placeholders.paramName")}
                url={url}
                onUrlChange={setUrl}
                valuePlaceholder={t("common.placeholders.paramValue")}
              />
            )}
          </Box>
        </Box>

        {/* Draggable Divider */}
        <Box
          aria-hidden
          onPointerDown={startResize}
          sx={{
            cursor: "row-resize",
            display: "flex",
            alignItems: "center",
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
              width: "100%",
              opacity: 0.7,
              transition: "background-color 120ms ease, opacity 120ms ease",
            },
            "&:hover::before": {
              bgcolor: "primary.main",
              opacity: 1,
            },
          }}
        />

        {/* Response Section */}
        <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          {sendMutation.isPending ? (
            <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ flex: 1 }}>
              <CircularProgress size={32} />
              <Typography color="text.secondary" variant="body2">
                {t("composePage.sendingRequest")}
              </Typography>
            </Stack>
          ) : sendMutation.isError ? (
            <Box sx={{ p: 2 }}>
              <Alert severity="error" variant="outlined">
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{t("composePage.requestFailed")}</Typography>
                <Typography variant="body2">{sendMutation.error.message || t("common.errors.unexpected")}</Typography>
              </Alert>
            </Box>
          ) : responseDetail ? (
            <>
              <Tabs
                onChange={(_, value) => setResponseTab(value)}
                sx={{ minHeight: 32, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}
                TabIndicatorProps={{ sx: { height: 2 } }}
                value={responseTab}
                variant="scrollable"
                scrollButtons="auto"
              >
                <Tab label={t("composePage.tabs.overview")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="overview" />
                <Tab label={`${t("composePage.tabs.headers")} (${responseDetail.responseHeaders.length})`} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="headers" />
                <Tab label="JSON" sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="json" />
                <Tab label="JSON Text" sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="jsonText" />
                <Tab label="Raw" sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="raw" />
                <Tab label={t("composePage.tabs.timing")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="timing" />
              </Tabs>
              {showSearch && (
                <Box sx={{ flexShrink: 0, px: 1, py: 0.5 }}>
                  <OutlinedInput
                    fullWidth
                    placeholder={responseTab === "json" ? t("inspector.response.jsonSearchPlaceholder") : t("inspector.response.jsonTextSearchPlaceholder")}
                    size="small"
                    sx={{ fontFamily: "JetBrains Mono, Consolas, monospace", fontSize: 12 }}
                    value={searchValue}
                    onChange={(e) => setSearchValue(e.target.value)}
                  />
                </Box>
              )}
              <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pt: 1.5, px: 0.5 }}>
                {responseTabContent}
              </Box>
            </>
          ) : (
            <Stack alignItems="center" justifyContent="center" sx={{ flex: 1 }}>
              <Typography color="text.secondary" variant="body2">
                {t("composePage.configureHint")}
              </Typography>
            </Stack>
          )}
        </Box>
      </Box>

      <Snackbar
        anchorOrigin={{ horizontal: "center", vertical: "bottom" }}
        autoHideDuration={2000}
        message={t("composePage.copiedCurl")}
        onClose={() => setSnackbarOpen(false)}
        open={snackbarOpen}
      />
    </Stack>
  );
}

function QueryParamsEditor({
  namePlaceholder,
  onUrlChange,
  url,
  valuePlaceholder,
}: {
  namePlaceholder: string;
  onUrlChange: (url: string) => void;
  url: string;
  valuePlaceholder: string;
}) {
  let params: Array<{ name: string; value: string }> = [];
  try {
    const parsed = new URL(url);
    params = Array.from(parsed.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    // URL not valid yet, show empty
  }

  function handleParamsChange(newParams: Array<{ name: string; value: string }>) {
    try {
      const parsed = new URL(url);
      parsed.search = "";
      for (const p of newParams) {
        if (p.name.trim()) {
          parsed.searchParams.append(p.name, p.value);
        }
      }
      onUrlChange(parsed.toString());
    } catch {
      // Can't update query if URL is invalid
    }
  }

  return (
    <EditableKeyValueTable
      items={params}
      namePlaceholder={namePlaceholder}
      onChange={(items) => handleParamsChange(items)}
      valuePlaceholder={valuePlaceholder}
    />
  );
}
