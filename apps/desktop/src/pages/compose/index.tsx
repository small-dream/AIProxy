import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import { Box, CircularProgress, Divider, IconButton, MenuItem, OutlinedInput, Select, Snackbar, Stack, Tooltip } from "@mui/material";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import type { HeaderEntry } from "@aiproxy/shared-types";

import { buildMultipartBody, FORMDATA_CONTENT_TYPE, RAW_LANGUAGE_CONTENT_TYPE, URLENCODED_CONTENT_TYPE, useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { ComposeRequestSection } from "@/features/compose/components/ComposeRequestSection";
import { ComposeResponseSection, type ComposeResponseTab } from "@/features/compose/components/ComposeResponseSection";
import { generateCurlCommand } from "@/features/compose/curl-export";
import { useSendComposedRequest } from "@/features/compose/use-compose-request";
import { getBodyText } from "@/features/sessions/components/session-inspector.helpers";
import { useI18n } from "@/i18n";
import { appFontCssVars } from "@/themes/fonts";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const COMPOSE_SPLIT_STORAGE_KEY = "aiproxy.compose.splitRatio";
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
  const bodyType = useComposeEditorStore((s) => s.bodyType);
  const rawLanguage = useComposeEditorStore((s) => s.rawLanguage);
  const urlEncodedEntries = useComposeEditorStore((s) => s.urlEncodedEntries);
  const formDataEntries = useComposeEditorStore((s) => s.formDataEntries);
  const activeTab = useComposeEditorStore((s) => s.activeTab);
  const setMethod = useComposeEditorStore((s) => s.setMethod);
  const setUrl = useComposeEditorStore((s) => s.setUrl);
  const setHeaders = useComposeEditorStore((s) => s.setHeaders);
  const setBody = useComposeEditorStore((s) => s.setBody);
  const setBodyType = useComposeEditorStore((s) => s.setBodyType);
  const setRawLanguage = useComposeEditorStore((s) => s.setRawLanguage);
  const setUrlEncodedEntries = useComposeEditorStore((s) => s.setUrlEncodedEntries);
  const setFormDataEntries = useComposeEditorStore((s) => s.setFormDataEntries);
  const setActiveTab = useComposeEditorStore((s) => s.setActiveTab);

  const responseDetail = sendMutation.data;
  const [responseTab, setResponseTab] = useState<ComposeResponseTab>("overview");
  const [searchValue, setSearchValue] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
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

  const encodeBody = useCallback((): { body: string | undefined; headers: HeaderEntry[] } => {
    let encodedBody: string | undefined;
    let finalHeaders = headers;

    switch (bodyType) {
      case "none":
        break;
      case "formdata": {
        const activeEntries = formDataEntries.filter((e) => e.name.trim());
        if (activeEntries.length > 0) {
          const boundary = `----AIProxyBoundary${Date.now().toString(16)}`;
          encodedBody = buildMultipartBody(activeEntries, boundary);
          finalHeaders = ensureContentType(finalHeaders, `${FORMDATA_CONTENT_TYPE}; boundary=${boundary}`);
        }
        break;
      }
      case "urlencoded": {
        const activeEntries = urlEncodedEntries.filter((e) => e.name.trim());
        if (activeEntries.length > 0) {
          encodedBody = activeEntries
            .map((e) => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`)
            .join("&");
          finalHeaders = ensureContentType(finalHeaders, URLENCODED_CONTENT_TYPE);
        }
        break;
      }
      case "raw": {
        if (body.trim()) {
          encodedBody = body;
          finalHeaders = ensureContentType(finalHeaders, RAW_LANGUAGE_CONTENT_TYPE[rawLanguage]);
        }
        break;
      }
    }
    return { body: encodedBody, headers: finalHeaders };
  }, [headers, body, bodyType, rawLanguage, urlEncodedEntries, formDataEntries]);

  const handleSend = useCallback(() => {
    const { body: encodedBody, headers: finalHeaders } = encodeBody();
    sendMutation.mutate({
      workspaceId: "default",
      method,
      url,
      headers: finalHeaders,
      ...(encodedBody ? { body: encodedBody } : {}),
    });
  }, [sendMutation, method, url, encodeBody]);

  const handleExportCurl = useCallback(() => {
    const { body: encodedBody, headers: finalHeaders } = encodeBody();
    const cmd = generateCurlCommand({ method, url, headers: finalHeaders, ...(encodedBody ? { body: encodedBody } : {}) });
    void navigator.clipboard?.writeText(cmd);
    setSnackbarOpen(true);
  }, [method, url, encodeBody]);

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

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      {/* URL Bar Row */}
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", pb: 1.5 }}>
        <Select
          size="small"
          sx={{ flex: "0 0 120px", fontFamily: appFontCssVars.content, fontSize: 13, fontWeight: 600 }}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          {HTTP_METHODS.map((m) => (
            <MenuItem key={m} sx={{ fontFamily: appFontCssVars.content, fontSize: 13 }} value={m}>
              {m}
            </MenuItem>
          ))}
        </Select>
        <OutlinedInput
          fullWidth
          placeholder={t("composePage.urlPlaceholder")}
          size="small"
          sx={{ fontFamily: appFontCssVars.content, fontSize: 13 }}
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
        <ComposeRequestSection
          activeTab={activeTab}
          body={body}
          bodyType={bodyType}
          formDataEntries={formDataEntries}
          headers={headers}
          onActiveTabChange={setActiveTab}
          onBodyChange={setBody}
          onBodyTypeChange={setBodyType}
          onFormDataEntriesChange={setFormDataEntries}
          onHeadersChange={setHeaders}
          onRawLanguageChange={setRawLanguage}
          onUrlChange={setUrl}
          onUrlEncodedEntriesChange={setUrlEncodedEntries}
          rawLanguage={rawLanguage}
          url={url}
          urlEncodedEntries={urlEncodedEntries}
        />

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

        <ComposeResponseSection
          errorMessage={sendMutation.error?.message}
          isError={sendMutation.isError}
          isPending={sendMutation.isPending}
          onCopyResponse={() => {
            void navigator.clipboard.writeText(responseBodyText ?? "");
            setSnackbarOpen(true);
          }}
          onResponseTabChange={setResponseTab}
          onSearchOpenChange={setSearchOpen}
          onSearchValueChange={setSearchValue}
          responseDetail={responseDetail}
          responseTab={responseTab}
          searchOpen={searchOpen}
          searchValue={searchValue}
        />
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

function ensureContentType(
  headers: Array<{ name: string; value: string }>,
  contentType: string,
): Array<{ name: string; value: string }> {
  const hasContentType = headers.some(
    (h) => h.name.toLowerCase() === "content-type",
  );
  if (hasContentType) return headers;
  return [...headers, { name: "Content-Type", value: contentType }];
}
