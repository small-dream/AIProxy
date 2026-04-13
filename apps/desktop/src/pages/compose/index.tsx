import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import { Alert, Box, Button, CircularProgress, Divider, MenuItem, OutlinedInput, Paper, Select, Snackbar, Stack, Tab, Tabs, TextField, Tooltip, Typography } from "@mui/material";
import { useState } from "react";

import { SectionCard } from "@/components/shared/SectionCard";
import { useComposeEditorStore } from "@/features/compose/compose-editor.store";
import { generateCurlCommand } from "@/features/compose/curl-export";
import { useSendComposedRequest } from "@/features/compose/use-compose-request";
import { EditableKeyValueTable } from "@/features/compose/components/EditableKeyValueTable";
import { InspectorDefinitionList, InspectorKeyValueTable, SearchableCodeBlock, InspectorSummaryBar } from "@/features/sessions/components/SessionInspectorShared";
import { useI18n } from "@/i18n";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

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
  const [responseTab, setResponseTab] = useState<"overview" | "headers" | "body" | "timing">("overview");
  const [snackbarOpen, setSnackbarOpen] = useState(false);

  function handleSend() {
    sendMutation.mutate({
      workspaceId: "default",
      method,
      url,
      headers,
      ...(body ? { body } : {}),
    });
  }

  function handleExportCurl() {
    const cmd = generateCurlCommand({ method, url, headers, ...(body ? { body } : {}) });
    void navigator.clipboard?.writeText(cmd);
    setSnackbarOpen(true);
  }

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
      case "body":
        return (
          <SearchableCodeBlock
            code={responseDetail.responseBody?.inlineText ?? responseDetail.rawResponse ?? t("composePage.responseNoBody")}
            language={responseDetail.responseBody?.mimeType?.includes("json") ? "json" : "plain"}
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
    <Stack spacing={3}>
        <Stack direction="row" justifyContent="space-between" spacing={2}>
          <Stack spacing={0.75}>
          <Typography variant="h4">{t("composePage.title")}</Typography>
          <Typography color="text.secondary" variant="body1">
            {t("composePage.description")}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
          <Button
            disabled={!url.trim()}
            onClick={handleSend}
            size="small"
            startIcon={sendMutation.isPending ? <CircularProgress size={16} color="inherit" /> : <SendRoundedIcon />}
            variant="contained"
          >
            {t("common.actions.send")}
          </Button>
          <Tooltip title={t("composePage.copyAsCurl")}>
            <span>
              <Button
                disabled={!url.trim()}
                onClick={handleExportCurl}
                size="small"
                startIcon={<ContentCopyRoundedIcon />}
                variant="outlined"
              >
                {t("common.actions.exportCurl")}
              </Button>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      <Box
        sx={{
          display: "grid",
          gap: 3,
          gridTemplateColumns: {
            md: "minmax(0, 8fr) minmax(0, 4fr)",
            xs: "1fr",
          },
        }}
      >
        {/* Request Builder */}
        <SectionCard description={t("composePage.requestBuilderDescription")} title={t("composePage.requestBuilderTitle")}>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
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
            </Stack>

            <Divider />

            <Tabs
              onChange={(_, value) => setActiveTab(value)}
              sx={{ minHeight: 32, borderBottom: 1, borderColor: "divider" }}
              TabIndicatorProps={{ sx: { height: 2 } }}
              value={activeTab}
              variant="scrollable"
              scrollButtons="auto"
            >
              <Tab label={`${t("composePage.tabs.headers")}${headers.length > 0 ? ` (${headers.length})` : ""}`} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="headers" />
              <Tab label={t("composePage.tabs.body")} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="body" />
              <Tab label={t("composePage.tabs.query")} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="query" />
            </Tabs>

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
                maxRows={16}
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
          </Stack>
        </SectionCard>

        {/* Response Preview */}
        <SectionCard description={t("composePage.responsePreviewDescription")} title={t("composePage.responsePreviewTitle")}>
          {sendMutation.isPending ? (
            <Stack alignItems="center" spacing={2} sx={{ py: 4 }}>
              <CircularProgress size={32} />
              <Typography color="text.secondary" variant="body2">
                {t("composePage.sendingRequest")}
              </Typography>
            </Stack>
          ) : sendMutation.isError ? (
            <Alert severity="error" variant="outlined">
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{t("composePage.requestFailed")}</Typography>
              <Typography variant="body2">{sendMutation.error.message || t("common.errors.unexpected")}</Typography>
            </Alert>
          ) : responseDetail ? (
            <Stack spacing={1.5}>
              <InspectorSummaryBar detail={responseDetail} session={responseDetail.summary} />
              <Divider />
              <Tabs
                onChange={(_, value) => setResponseTab(value)}
                sx={{ minHeight: 32, borderBottom: 1, borderColor: "divider" }}
                TabIndicatorProps={{ sx: { height: 2 } }}
                value={responseTab}
                variant="scrollable"
                scrollButtons="auto"
              >
                <Tab label={t("composePage.tabs.overview")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="overview" />
                <Tab label={`${t("composePage.tabs.headers")} (${responseDetail.responseHeaders.length})`} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="headers" />
                <Tab label={t("composePage.tabs.body")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="body" />
                <Tab label={t("composePage.tabs.timing")} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="timing" />
              </Tabs>
              <Box sx={{ overflow: "auto" }}>{responseTabContent}</Box>
            </Stack>
          ) : (
            <Typography color="text.secondary" sx={{ py: 2 }} variant="body2">
              {t("composePage.configureHint")}
            </Typography>
          )}
        </SectionCard>
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
