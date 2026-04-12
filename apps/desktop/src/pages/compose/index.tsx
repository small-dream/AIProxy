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

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function ComposePage() {
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
              ["Status", String(responseDetail.summary.statusCode)],
              ["Duration", `${responseDetail.summary.durationMs} ms`],
              ["Size", `${responseDetail.summary.sizeBytes} bytes`],
              ["Response Body", responseDetail.responseBody ? `${responseDetail.responseBody.sizeBytes} bytes` : "No body"],
              ["Timing Total", responseDetail.timing?.totalMs != null ? `${responseDetail.timing.totalMs} ms` : "Not captured"],
            ]}
          />
        );
      case "headers":
        return (
          <InspectorKeyValueTable
            emptyMessage="No response headers."
            items={responseDetail.responseHeaders.map((h) => [h.name, h.value])}
          />
        );
      case "body":
        return (
          <SearchableCodeBlock
            code={responseDetail.responseBody?.inlineText ?? responseDetail.rawResponse ?? "No response body."}
            language={responseDetail.responseBody?.mimeType?.includes("json") ? "json" : "plain"}
            searchQuery=""
          />
        );
      case "timing": {
        const t = responseDetail.timing;
        return (
          <InspectorDefinitionList
            items={[
              ["DNS", t?.dnsMs != null ? `${t.dnsMs} ms` : "Not captured"],
              ["Connect", t?.connectMs != null ? `${t.connectMs} ms` : "Not captured"],
              ["TLS", t?.tlsMs != null ? `${t.tlsMs} ms` : "Not captured"],
              ["Request Send", t?.requestSendMs != null ? `${t.requestSendMs} ms` : "Not captured"],
              ["Waiting", t?.waitingMs != null ? `${t.waitingMs} ms` : "Not captured"],
              ["Response Read", t?.responseReadMs != null ? `${t.responseReadMs} ms` : "Not captured"],
              ["Total", t?.totalMs != null ? `${t.totalMs} ms` : "Not captured"],
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
          <Typography variant="h4">Compose</Typography>
          <Typography color="text.secondary" variant="body1">
            Build and replay requests without leaving the desktop workspace.
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
            Send
          </Button>
          <Tooltip title="Copy as cURL command">
            <span>
              <Button
                disabled={!url.trim()}
                onClick={handleExportCurl}
                size="small"
                startIcon={<ContentCopyRoundedIcon />}
                variant="outlined"
              >
                Export cURL
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
        <SectionCard description="Configure the HTTP request to send." title="Request Builder">
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
                placeholder="https://example.com/api/resource"
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
              <Tab label={`Headers${headers.length > 0 ? ` (${headers.length})` : ""}`} sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="headers" />
              <Tab label="Body" sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="body" />
              <Tab label="Query" sx={{ minHeight: 32, minWidth: 80, py: 0 }} value="query" />
            </Tabs>

            {activeTab === "headers" && (
              <EditableKeyValueTable
                items={headers}
                namePlaceholder="Header name"
                onChange={setHeaders}
                valuePlaceholder="Header value"
              />
            )}

            {activeTab === "body" && (
              <TextField
                fullWidth
                minRows={6}
                maxRows={16}
                multiline
                placeholder="Request body (JSON, plain text, etc.)"
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
              <QueryParamsEditor url={url} onUrlChange={setUrl} />
            )}
          </Stack>
        </SectionCard>

        {/* Response Preview */}
        <SectionCard description="Response will appear after sending a request." title="Response Preview">
          {sendMutation.isPending ? (
            <Stack alignItems="center" spacing={2} sx={{ py: 4 }}>
              <CircularProgress size={32} />
              <Typography color="text.secondary" variant="body2">
                Sending request...
              </Typography>
            </Stack>
          ) : sendMutation.isError ? (
            <Alert severity="error" variant="outlined">
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Request failed</Typography>
              <Typography variant="body2">{sendMutation.error.message || "An unexpected error occurred."}</Typography>
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
                <Tab label="Overview" sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="overview" />
                <Tab label={`Headers (${responseDetail.responseHeaders.length})`} sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="headers" />
                <Tab label="Body" sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="body" />
                <Tab label="Timing" sx={{ minHeight: 32, minWidth: 72, py: 0 }} value="timing" />
              </Tabs>
              <Box sx={{ overflow: "auto" }}>{responseTabContent}</Box>
            </Stack>
          ) : (
            <Typography color="text.secondary" sx={{ py: 2 }} variant="body2">
              Configure a request and click Send to see the response here.
            </Typography>
          )}
        </SectionCard>
      </Box>

      <Snackbar
        anchorOrigin={{ horizontal: "center", vertical: "bottom" }}
        autoHideDuration={2000}
        message="cURL command copied to clipboard"
        onClose={() => setSnackbarOpen(false)}
        open={snackbarOpen}
      />
    </Stack>
  );
}

function QueryParamsEditor({ url, onUrlChange }: { url: string; onUrlChange: (url: string) => void }) {
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
      namePlaceholder="Param name"
      onChange={(items) => handleParamsChange(items)}
      valuePlaceholder="Param value"
    />
  );
}
