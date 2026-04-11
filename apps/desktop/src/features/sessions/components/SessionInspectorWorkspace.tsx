import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import type {
  BodyReference,
  HeaderEntry,
  SessionDetail,
  SessionSummary,
} from "@pharles/shared-types";

export type InspectorPrimaryTab = "overview" | "contents" | "summary" | "timing" | "raw";
export type InspectorSecondaryTab = "headers" | "text" | "hex" | "raw";

type SessionInspectorWorkspaceProps = {
  detailErrorMessage: string | undefined;
  isDetailLoading: boolean;
  onPrimaryTabChange: (tab: InspectorPrimaryTab) => void;
  onSecondaryTabChange: (tab: InspectorSecondaryTab) => void;
  primaryTab: InspectorPrimaryTab;
  secondaryTab: InspectorSecondaryTab;
  selectedSession: SessionSummary | undefined;
  selectedSessionDetail: SessionDetail | undefined;
};

export function SessionInspectorWorkspace({
  detailErrorMessage,
  isDetailLoading,
  onPrimaryTabChange,
  onSecondaryTabChange,
  primaryTab,
  secondaryTab,
  selectedSession,
  selectedSessionDetail,
}: SessionInspectorWorkspaceProps) {
  if (!selectedSession) {
    return (
      <Paper
        elevation={0}
        sx={{
          border: 1,
          borderColor: "divider",
          display: "flex",
          minHeight: 0,
        }}
        variant="outlined"
      >
        <Stack justifyContent="center" spacing={1} sx={{ p: 3 }}>
          <Typography variant="h6">Inspector Workspace</Typography>
          <Typography color="text.secondary" variant="body2">
            Select a captured request to inspect headers, body, timing, and raw HTTP messages.
          </Typography>
        </Stack>
      </Paper>
    );
  }

  const detail =
    selectedSessionDetail?.id === selectedSession.id ? selectedSessionDetail : undefined;

  return (
    <Paper
      elevation={0}
      sx={{
        border: 1,
        borderColor: "divider",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
      variant="outlined"
    >
      <Stack spacing={0.75} sx={{ px: 1.5, py: 1 }}>
        <Stack
          alignItems="center"
          direction="row"
          justifyContent="space-between"
          spacing={1.5}
        >
          <Stack alignItems="center" direction="row" spacing={1} sx={{ minWidth: 0 }}>
            <Chip color={getStatusColor(selectedSession.statusCode)} label={selectedSession.method} size="small" variant="outlined" />
            <Typography noWrap variant="subtitle2">
              {selectedSession.path || "/"}
            </Typography>
            <Typography color="text.secondary" noWrap variant="caption">
              {selectedSession.statusCode} • {selectedSession.durationMs} ms • {selectedSession.sizeBytes} bytes
            </Typography>
          </Stack>

          <Stack direction="row" spacing={0.75}>
            <Button size="small" startIcon={<ReplayRoundedIcon />} sx={{ minWidth: 0, px: 1.25 }} variant="text">
              Repeat
            </Button>
            <Button size="small" startIcon={<ContentCopyRoundedIcon />} sx={{ minWidth: 0, px: 1.25 }} variant="text">
              Copy URL
            </Button>
          </Stack>
        </Stack>

        <Typography color="text.secondary" noWrap sx={{ fontSize: 11.5, lineHeight: 1.3 }}>
          {selectedSession.host} • {selectedSession.protocol} • {selectedSession.url}
        </Typography>
      </Stack>

      <Divider />

      <Tabs
        onChange={(_event, nextTab: InspectorPrimaryTab) =>
          onPrimaryTabChange(nextTab)
        }
        scrollButtons="auto"
        sx={{ bgcolor: "background.paper", minHeight: 32, px: 0.5 }}
        value={primaryTab}
        variant="scrollable"
      >
        <Tab label="Overview" value="overview" />
        <Tab label="Contents" value="contents" />
        <Tab label="Summary" value="summary" />
        <Tab label="Timing" value="timing" />
        <Tab label="Raw" value="raw" />
      </Tabs>

      <Divider />

      {primaryTab === "contents" ? (
        <>
          <Tabs
            onChange={(_event, nextTab: InspectorSecondaryTab) =>
              onSecondaryTabChange(nextTab)
            }
            sx={{ bgcolor: "action.hover", minHeight: 30, px: 0.5 }}
            value={secondaryTab}
          >
            <Tab label="Headers" value="headers" />
            <Tab label="Text" value="text" />
            <Tab label="Hex" value="hex" />
            <Tab label="Raw" value="raw" />
          </Tabs>
          <Divider />
        </>
      ) : null}

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 2 }}>
        {detailErrorMessage ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {detailErrorMessage}
          </Alert>
        ) : null}

        {isDetailLoading && !detail ? (
          <Typography color="text.secondary" variant="body2">
            Loading selected session detail...
          </Typography>
        ) : (
          renderInspectorContent(primaryTab, secondaryTab, selectedSession, detail)
        )}
      </Box>
    </Paper>
  );
}

function renderInspectorContent(
  primaryTab: InspectorPrimaryTab,
  secondaryTab: InspectorSecondaryTab,
  session: SessionSummary,
  detail: SessionDetail | undefined,
) {
  if (primaryTab === "overview") {
    return (
      <Stack spacing={2}>
        <InspectorDefinitionList
          items={[
            ["Method", session.method],
            ["Host", session.host],
            ["Path", session.path || "/"],
            ["Status", String(session.statusCode)],
            ["Protocol", session.protocol],
            ["Duration", `${session.durationMs} ms`],
            ["Size", `${session.sizeBytes} bytes`],
            ["Started", session.startedAt],
            ["Finished", session.finishedAt],
            ["Server IP", detail?.serverIp ?? "Unavailable in current HTTP phase"],
          ]}
        />
        <Stack spacing={1}>
          <Typography variant="subtitle2">Query Parameters</Typography>
          <InspectorDefinitionList
            emptyMessage="No query parameters."
            items={
              detail?.queryParams.map((entry) => [entry.name, entry.value]) ?? []
            }
          />
        </Stack>
        <Stack spacing={1}>
          <Typography variant="subtitle2">Cookies</Typography>
          <InspectorDefinitionList
            emptyMessage="No cookie headers captured."
            items={detail?.cookies.map((entry) => [entry.name, entry.value]) ?? []}
          />
        </Stack>
      </Stack>
    );
  }

  if (primaryTab === "summary") {
    return (
      <InspectorDefinitionList
        items={[
          ["URL", session.url],
          ["Request Headers", String(detail?.requestHeaders.length ?? 0)],
          ["Response Headers", String(detail?.responseHeaders.length ?? 0)],
          [
            "Request Body",
            describeBody(detail?.requestBody) ?? "No request body captured",
          ],
          [
            "Response Body",
            describeBody(detail?.responseBody) ?? "No response body captured",
          ],
          ["Inspector Source", detail ? "Desktop session detail API" : "Session summary only"],
        ]}
      />
    );
  }

  if (primaryTab === "timing") {
    if (!detail?.timing) {
      return (
        <Typography color="text.secondary" variant="body2">
          Timing detail is not available for this session.
        </Typography>
      );
    }

    return (
      <InspectorDefinitionList
        items={[
          ["DNS", formatTiming(detail.timing.dnsMs)],
          ["Connect", formatTiming(detail.timing.connectMs)],
          ["TLS", formatTiming(detail.timing.tlsMs)],
          ["Request Send", formatTiming(detail.timing.requestSendMs)],
          ["Waiting", formatTiming(detail.timing.waitingMs)],
          ["Response Read", formatTiming(detail.timing.responseReadMs)],
          ["Total", formatTiming(detail.timing.totalMs)],
        ]}
      />
    );
  }

  if (primaryTab === "raw") {
    return (
      <Stack spacing={2}>
        <RawMessageSection
          label="Raw Request"
          value={detail?.rawRequest ?? "Raw request is not available."}
        />
        <RawMessageSection
          label="Raw Response"
          value={detail?.rawResponse ?? "Raw response is not available."}
        />
      </Stack>
    );
  }

  if (secondaryTab === "headers") {
    return (
      <Stack spacing={2}>
        <HeaderSection
          entries={detail?.requestHeaders ?? []}
          label="Request Headers"
        />
        <HeaderSection
          entries={detail?.responseHeaders ?? []}
          label="Response Headers"
        />
      </Stack>
    );
  }

  if (secondaryTab === "text") {
    return (
      <Stack spacing={2}>
        <BodySection body={detail?.requestBody} label="Request Body" mode="text" />
        <BodySection
          body={detail?.responseBody}
          label="Response Body"
          mode="text"
        />
      </Stack>
    );
  }

  if (secondaryTab === "hex") {
    return (
      <Stack spacing={2}>
        <BodySection body={detail?.requestBody} label="Request Body" mode="hex" />
        <BodySection
          body={detail?.responseBody}
          label="Response Body"
          mode="hex"
        />
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <RawMessageSection
        label="Raw Request"
        value={detail?.rawRequest ?? "Raw request is not available."}
      />
      <RawMessageSection
        label="Raw Response"
        value={detail?.rawResponse ?? "Raw response is not available."}
      />
    </Stack>
  );
}

function HeaderSection({
  entries,
  label,
}: {
  entries: HeaderEntry[];
  label: string;
}) {
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{label}</Typography>
      <InspectorDefinitionList
        emptyMessage={`No ${label.toLowerCase()} captured.`}
        items={entries.map((entry) => [entry.name, entry.value])}
      />
    </Stack>
  );
}

function BodySection({
  body,
  label,
  mode,
}: {
  body: BodyReference | undefined;
  label: string;
  mode: "hex" | "text";
}) {
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{label}</Typography>
      <Typography color="text.secondary" variant="caption">
        {describeBody(body) ?? "No body captured."}
      </Typography>
      <InspectorCodeBlock
        code={
          mode === "text"
            ? body?.inlineText ?? "No text body available for this payload."
            : formatHexPreview(body?.base64Text)
        }
      />
    </Stack>
  );
}

function RawMessageSection({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{label}</Typography>
      <InspectorCodeBlock code={value} />
    </Stack>
  );
}

function InspectorDefinitionList({
  emptyMessage,
  items,
}: {
  emptyMessage?: string;
  items: Array<[string, string]>;
}) {
  if (items.length === 0) {
    return (
      <Typography color="text.secondary" variant="body2">
        {emptyMessage ?? "No data available."}
      </Typography>
    );
  }

  return (
    <List disablePadding>
      {items.map(([label, value]) => (
        <ListItem disableGutters divider key={`${label}:${value}`} sx={{ alignItems: "flex-start", py: 0.75 }}>
          <ListItemText
            primary={label}
            primaryTypographyProps={{ color: "text.secondary", variant: "caption" }}
            secondary={value}
            secondaryTypographyProps={{
              sx: { mt: 0.5, wordBreak: "break-all" },
              variant: "body2",
            }}
          />
        </ListItem>
      ))}
    </List>
  );
}

function InspectorCodeBlock({ code }: { code: string }) {
  return (
    <Box
      component="pre"
      sx={{
        bgcolor: "action.hover",
        border: 1,
        borderColor: "divider",
        fontFamily: "JetBrains Mono, Consolas, monospace",
        fontSize: 12.5,
        lineHeight: 1.5,
        m: 0,
        overflowX: "auto",
        p: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {code}
    </Box>
  );
}

function describeBody(body: BodyReference | undefined) {
  if (!body) {
    return undefined;
  }

  const mimeType = body.mimeType ?? "unknown";
  const truncationSuffix = body.truncated ? " (truncated preview)" : "";

  return `${mimeType} - ${body.sizeBytes} bytes${truncationSuffix}`;
}

function formatTiming(value: number | undefined) {
  return value === undefined ? "Not captured" : `${value} ms`;
}

function getStatusColor(statusCode: number): "default" | "error" | "info" | "success" | "warning" {
  if (statusCode >= 500) {
    return "error";
  }

  if (statusCode >= 400) {
    return "warning";
  }

  if (statusCode >= 300) {
    return "info";
  }

  if (statusCode >= 200) {
    return "success";
  }

  return "default";
}

function formatHexPreview(base64Text: string | undefined) {
  if (!base64Text) {
    return "No binary payload available.";
  }

  try {
    const decoded = atob(base64Text);
    const bytes = Array.from(decoded, (character) =>
      character.charCodeAt(0).toString(16).padStart(2, "0"),
    );
    const rows: string[] = [];

    for (let index = 0; index < bytes.length; index += 16) {
      rows.push(bytes.slice(index, index + 16).join(" "));
    }

    return rows.join("\n");
  } catch {
    return "Unable to decode payload into hexadecimal preview.";
  }
}
