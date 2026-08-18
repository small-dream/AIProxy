import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import BookmarkAddRoundedIcon from "@mui/icons-material/BookmarkAddRounded";
import TerminalRoundedIcon from "@mui/icons-material/TerminalRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  OutlinedInput,
  Select,
  Snackbar,
  Stack,
  Tooltip,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  readActiveEnvironmentId,
  writeActiveEnvironmentId,
} from "@/features/environments/active-environment";
import { EnvironmentSelector } from "@/features/environments/components/EnvironmentSelector";
import { EnvironmentManagerDialog } from "@/features/environments/components/EnvironmentManagerDialog";
import {
  buildMergedVariableMap,
  useEnvironments,
  useEnvironmentVariables,
  useGlobalVariables,
} from "@/features/environments/use-environments";
import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { encodeComposedRequest } from "@/features/compose/encode-request";
import { ComposeRequestSection } from "@/features/compose/components/ComposeRequestSection";
import {
  ComposeResponseSection,
  type ComposeResponseTab,
} from "@/features/compose/components/ComposeResponseSection";
import { generateCurlCommand } from "@/features/compose/curl-export";
import { CurlImportDialog } from "@/features/compose/components/CurlImportDialog";
import { useSendComposedRequest } from "@/features/compose/use-compose-request";
import { SaveToCollectionDialog } from "@/features/collections/components/SaveToCollectionDialog";
import { useUpsertCollectionItem } from "@/features/collections/use-collection-items";
import { useNotificationStore } from "@/services/notification.store";
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
  const upsertItemMutation = useUpsertCollectionItem();

  const environmentsQuery = useEnvironments();
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(() =>
    readActiveEnvironmentId(),
  );
  const envVarsQuery = useEnvironmentVariables(activeEnvironmentId);
  const globalVarsQuery = useGlobalVariables();
  const mergedVarMap = useMemo(
    () => buildMergedVariableMap(envVarsQuery.data ?? [], globalVarsQuery.data ?? []),
    [envVarsQuery.data, globalVarsQuery.data],
  );
  const [manageEnvDialogOpen, setManageEnvDialogOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [curlImportOpen, setCurlImportOpen] = useState(false);

  useEffect(() => {
    writeActiveEnvironmentId(activeEnvironmentId);
  }, [activeEnvironmentId]);

  const method = useComposeEditorStore((s) => s.method);
  const url = useComposeEditorStore((s) => s.url);
  const headers = useComposeEditorStore((s) => s.headers);
  const body = useComposeEditorStore((s) => s.body);
  const bodyType = useComposeEditorStore((s) => s.bodyType);
  const rawLanguage = useComposeEditorStore((s) => s.rawLanguage);
  const urlEncodedEntries = useComposeEditorStore((s) => s.urlEncodedEntries);
  const formDataEntries = useComposeEditorStore((s) => s.formDataEntries);
  const formFiles = useComposeEditorStore((s) => s.formFiles);
  const activeTab = useComposeEditorStore((s) => s.activeTab);
  const setMethod = useComposeEditorStore((s) => s.setMethod);
  const setUrl = useComposeEditorStore((s) => s.setUrl);
  const setHeaders = useComposeEditorStore((s) => s.setHeaders);
  const setBody = useComposeEditorStore((s) => s.setBody);
  const setBodyType = useComposeEditorStore((s) => s.setBodyType);
  const setRawLanguage = useComposeEditorStore((s) => s.setRawLanguage);
  const setUrlEncodedEntries = useComposeEditorStore((s) => s.setUrlEncodedEntries);
  const setFormDataEntries = useComposeEditorStore((s) => s.setFormDataEntries);
  const setFormFiles = useComposeEditorStore((s) => s.setFormFiles);
  const setActiveTab = useComposeEditorStore((s) => s.setActiveTab);

  const responseDetail = sendMutation.data;
  const [responseTab, setResponseTab] = useState<ComposeResponseTab>("overview");
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [splitRatio, setSplitRatio] = useState(COMPOSE_SPLIT_DEFAULT);
  const dragFrameRef = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // M21: tracks the active resize cleanup fn so a mid-drag unmount can remove
  // the window pointer listeners (and cancel the pending animation frame)
  // instead of leaking them until some unrelated pointerup elsewhere fires.
  const resizeCleanupRef = useRef<(() => void) | null>(null);

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

  // Cleanup animation frame and any in-flight resize listeners (M21).
  useEffect(() => {
    return () => {
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      const resizeCleanup = resizeCleanupRef.current;
      if (resizeCleanup) resizeCleanup();
      resizeCleanupRef.current = null;
    };
  }, []);

  const encodeBody = useCallback(() => {
    return encodeComposedRequest(
      {
        headers,
        body,
        bodyType,
        rawLanguage,
        url,
        formDataEntries,
        formFiles,
        urlEncodedEntries,
      },
      mergedVarMap,
    );
  }, [
    headers,
    body,
    bodyType,
    rawLanguage,
    url,
    urlEncodedEntries,
    formDataEntries,
    formFiles,
    mergedVarMap,
  ]);

  const handleSend = useCallback(() => {
    const { multipartEntries, textBody: encodedBody, headers: finalHeaders, url: finalUrl } =
      encodeBody();
    sendMutation.mutate({
      workspaceId: "default",
      method,
      url: finalUrl,
      headers: finalHeaders,
      ...(encodedBody !== undefined ? { body: encodedBody } : {}),
      ...(multipartEntries && multipartEntries.length > 0 ? { multipartEntries } : {}),
    });
  }, [sendMutation, method, encodeBody]);

  const handleExportCurl = useCallback(() => {
    const { multipartEntries, textBody: encodedBody, headers: finalHeaders, url: finalUrl } =
      encodeBody();
    const cmd = generateCurlCommand({
      method,
      url: finalUrl,
      headers: finalHeaders,
      ...(encodedBody !== undefined ? { body: encodedBody } : {}),
      ...(multipartEntries && multipartEntries.length > 0 ? { multipartEntries } : {}),
    });
    void navigator.clipboard?.writeText(cmd);
    setSnackbarOpen(true);
  }, [method, encodeBody]);

  const handleSaveToCollection = useCallback(
    (collectionId: string, name?: string) => {
      upsertItemMutation.mutate(
        {
          collectionId,
          name: name?.trim() || `${method} ${url}`.trim(),
          method,
          url,
          headers,
          body,
          bodyType,
          rawLanguage,
          formData: formDataEntries,
          urlEncoded: urlEncodedEntries,
          formFiles,
        },
        {
          onSuccess: () => {
            useNotificationStore.getState().push(
              t("composePage.savedToCollection", {
                name: name?.trim() || `${method} ${url}`.trim(),
              }),
            );
            setSaveDialogOpen(false);
          },
        },
      );
    },
    [
      body,
      bodyType,
      formDataEntries,
      formFiles,
      headers,
      method,
      rawLanguage,
      t,
      upsertItemMutation,
      url,
      urlEncodedEntries,
    ],
  );

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

    const target = event.currentTarget;
    // M21: store the cleanup on the ref so the unmount effect can run it if
    // the page is torn down mid-drag, cancel the pending animation frame, and
    // release the pointer capture so it does not outlive the drag.
    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // releasePointerCapture throws if the capture was already released;
        // the capture is gone either way.
      }
      if (resizeCleanupRef.current === stopResize) {
        resizeCleanupRef.current = null;
      }
    };
    resizeCleanupRef.current = stopResize;

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  return (
    <Stack spacing={0.375} sx={{ height: "100%", minHeight: 0 }}>
      <Box
        sx={(theme) => ({
          bgcolor: alpha(
            theme.palette.background.paper,
            theme.palette.mode === "dark" ? 0.78 : 0.92,
          ),
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
          boxShadow:
            theme.palette.mode === "dark"
              ? "0 12px 28px rgba(0, 0, 0, 0.22)"
              : "0 12px 28px rgba(15, 23, 42, 0.05)",
          flexShrink: 0,
          p: 0.75,
        })}
      >
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
          <Select
            size="small"
            sx={{
              flex: "0 0 112px",
              fontFamily: appFontCssVars.content,
              fontSize: 13,
              fontWeight: 700,
              "& .MuiSelect-select": {
                alignItems: "center",
                display: "flex",
                minHeight: 22,
                py: 0.875,
              },
            }}
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
            sx={{
              bgcolor: (theme) =>
                alpha(
                  theme.palette.background.default,
                  theme.palette.mode === "dark" ? 0.34 : 0.52,
                ),
              fontFamily: appFontCssVars.content,
              fontSize: 13,
              minWidth: 0,
              "& .MuiOutlinedInput-input": {
                py: 1.05,
              },
            }}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && url.trim()) handleSend();
            }}
          />
          <EnvironmentSelector
            activeEnvironmentId={activeEnvironmentId}
            compact
            environments={environmentsQuery.data ?? []}
            hasEnvError={environmentsQuery.isError}
            onEnvironmentChange={setActiveEnvironmentId}
            onManageEnvironments={() => setManageEnvDialogOpen(true)}
          />
          <Tooltip title={t("composePage.importCurl")}>
            <span>
              <IconButton
                color="primary"
                onClick={() => setCurlImportOpen(true)}
                size="small"
                sx={{
                  border: 1,
                  borderColor: "divider",
                  flex: "0 0 auto",
                  height: 38,
                  width: 38,
                }}
              >
                <TerminalRoundedIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t("collectionsPage.saveToCollection")}>
            <span>
              <IconButton
                color="primary"
                disabled={!url.trim()}
                onClick={() => setSaveDialogOpen(true)}
                size="small"
                sx={{
                  border: 1,
                  borderColor: "divider",
                  flex: "0 0 auto",
                  height: 38,
                  width: 38,
                }}
              >
                <BookmarkAddRoundedIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t("common.actions.send")}>
            <span>
              <Button
                disabled={!url.trim() || sendMutation.isPending}
                onClick={handleSend}
                size="small"
                startIcon={sendMutation.isPending ? undefined : <SendRoundedIcon />}
                sx={{
                  flex: "0 0 auto",
                  minHeight: 38,
                  minWidth: 92,
                  px: 1.75,
                  "& .MuiButton-startIcon": {
                    mr: 0.5,
                  },
                }}
                variant="contained"
              >
                {sendMutation.isPending ? (
                  <CircularProgress size={18} color="inherit" />
                ) : (
                  t("common.actions.send")
                )}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={t("composePage.copyAsCurl")}>
            <span>
              <IconButton
                color="primary"
                disabled={!url.trim()}
                onClick={handleExportCurl}
                size="small"
                sx={{
                  border: 1,
                  borderColor: "divider",
                  flex: "0 0 auto",
                  height: 38,
                  width: 38,
                }}
              >
                <ContentCopyRoundedIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Box>

      <EnvironmentManagerDialog
        open={manageEnvDialogOpen}
        onClose={() => setManageEnvDialogOpen(false)}
      />
      <SaveToCollectionDialog
        open={saveDialogOpen}
        sessionName={`${method} ${url}`.trim() || t("composePage.untitledRequest")}
        onCancel={() => setSaveDialogOpen(false)}
        onConfirm={handleSaveToCollection}
      />
      <CurlImportDialog open={curlImportOpen} onClose={() => setCurlImportOpen(false)} />

      <Box
        ref={gridRef}
        sx={{
          display: "grid",
          flex: "1 1 0",
          gap: 0,
          gridTemplateRows: `${splitRatio}fr 1px ${1 - splitRatio}fr`,
          minHeight: 0,
        }}
      >
        <ComposeRequestSection
          activeTab={activeTab}
          body={body}
          bodyType={bodyType}
          formDataEntries={formDataEntries}
          formFiles={formFiles}
          headers={headers}
          onActiveTabChange={setActiveTab}
          onBodyChange={setBody}
          onBodyTypeChange={setBodyType}
          onFormDataEntriesChange={setFormDataEntries}
          onFormFilesChange={setFormFiles}
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
              bgcolor: (theme) =>
                alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.76 : 1),
              content: '""',
              height: 1,
              opacity: 1,
              transition: "background-color 120ms ease, opacity 120ms ease",
              width: "100%",
            },
            "&::after": {
              content: '""',
              inset: "-3px 0",
              position: "absolute",
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
          onResponseTabChange={setResponseTab}
          responseDetail={responseDetail}
          responseTab={responseTab}
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
