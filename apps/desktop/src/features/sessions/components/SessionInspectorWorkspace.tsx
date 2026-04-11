import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import {
  Box,
  Button,
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
import type { SessionSummary } from "@pharles/shared-types";

export type InspectorPrimaryTab = "overview" | "contents" | "summary" | "timing" | "raw";
export type InspectorSecondaryTab = "headers" | "text" | "hex" | "raw";

type SessionInspectorWorkspaceProps = {
  onPrimaryTabChange: (tab: InspectorPrimaryTab) => void;
  onSecondaryTabChange: (tab: InspectorSecondaryTab) => void;
  primaryTab: InspectorPrimaryTab;
  secondaryTab: InspectorSecondaryTab;
  selectedSession: SessionSummary | undefined;
};

export function SessionInspectorWorkspace({
  onPrimaryTabChange,
  onSecondaryTabChange,
  primaryTab,
  secondaryTab,
  selectedSession,
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
            Select a request from the host tree to inspect its overview, contents, timing, and raw preview.
          </Typography>
        </Stack>
      </Paper>
    );
  }

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
      <Stack spacing={1.5} sx={{ px: 2, py: 1.5 }}>
        <Stack alignItems="center" direction="row" justifyContent="space-between" spacing={2}>
          <Box sx={{ minWidth: 0 }}>
            <Typography noWrap variant="subtitle1">
              {selectedSession.method} {selectedSession.path || "/"} - {selectedSession.statusCode}
            </Typography>
            <Typography color="text.secondary" noWrap variant="body2">
              {selectedSession.host} • {selectedSession.protocol} • {selectedSession.durationMs} ms
            </Typography>
          </Box>

          <Stack direction="row" spacing={1}>
            <Button size="small" startIcon={<ReplayRoundedIcon />} variant="outlined">
              Repeat
            </Button>
            <Button size="small" startIcon={<ContentCopyRoundedIcon />} variant="outlined">
              Copy URL
            </Button>
          </Stack>
        </Stack>

        <Typography color="text.secondary" sx={{ wordBreak: "break-all" }} variant="caption">
          {selectedSession.url}
        </Typography>
      </Stack>

      <Divider />

      <Tabs
        onChange={(_event, nextTab: InspectorPrimaryTab) => onPrimaryTabChange(nextTab)}
        scrollButtons="auto"
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
          <Tabs onChange={(_event, nextTab: InspectorSecondaryTab) => onSecondaryTabChange(nextTab)} value={secondaryTab}>
            <Tab label="Headers" value="headers" />
            <Tab label="Text" value="text" />
            <Tab label="Hex" value="hex" />
            <Tab label="Raw" value="raw" />
          </Tabs>
          <Divider />
        </>
      ) : null}

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 2 }}>
        {renderInspectorContent(primaryTab, secondaryTab, selectedSession)}
      </Box>
    </Paper>
  );
}

function renderInspectorContent(
  primaryTab: InspectorPrimaryTab,
  secondaryTab: InspectorSecondaryTab,
  session: SessionSummary,
) {
  if (primaryTab === "overview") {
    return (
      <InspectorDefinitionList
        items={[
          ["Method", session.method],
          ["Host", session.host],
          ["Path", session.path || "/"],
          ["Status", String(session.statusCode)],
          ["Protocol", session.protocol],
          ["Duration", `${session.durationMs} ms`],
          ["Size", `${session.sizeBytes} bytes`],
        ]}
      />
    );
  }

  if (primaryTab === "summary") {
    return (
      <InspectorDefinitionList
        items={[
          ["URL", session.url],
          ["Started", session.startedAt],
          ["Finished", session.finishedAt],
          ["Workspace Flow", "Host-grouped capture workspace"],
          ["Inspector Mode", "Summary projection from session list payload"],
        ]}
      />
    );
  }

  if (primaryTab === "timing") {
    return (
      <Stack spacing={2}>
        <Typography variant="body2">Total duration: {session.durationMs} ms</Typography>
        <Typography color="text.secondary" variant="body2">
          Detailed DNS, connect, TLS, request upload, and first-byte timing will appear once the session detail API is
          connected.
        </Typography>
      </Stack>
    );
  }

  if (primaryTab === "raw") {
    return (
      <InspectorCodeBlock
        code={`${session.method} ${session.path || "/"} ${session.protocol}\nHost: ${session.host}\nStatus: ${session.statusCode}\nURL: ${session.url}`}
      />
    );
  }

  if (secondaryTab === "headers") {
    return (
      <InspectorDefinitionList
        items={[
          ["Host", session.host],
          ["Method", session.method],
          ["Protocol", session.protocol],
          ["URL", session.url],
        ]}
      />
    );
  }

  if (secondaryTab === "text") {
    return (
      <InspectorCodeBlock
        code={`Request target: ${session.url}\nStatus: ${session.statusCode}\nThe text body preview will render here once the session detail endpoint is connected.`}
      />
    );
  }

  if (secondaryTab === "hex") {
    return <InspectorCodeBlock code="48 54 54 50 ...\nHex preview placeholder for captured payload bytes." />;
  }

  return (
    <InspectorCodeBlock
      code={`${session.method} ${session.path || "/"} ${session.protocol}\nHost: ${session.host}\n\n<Response payload preview pending detail API>`}
    />
  );
}

function InspectorDefinitionList({ items }: { items: Array<[string, string]> }) {
  return (
    <List disablePadding>
      {items.map(([label, value]) => (
        <ListItem disableGutters divider key={label} sx={{ alignItems: "flex-start", py: 1 }}>
          <ListItemText
            primary={label}
            primaryTypographyProps={{ color: "text.secondary", variant: "caption" }}
            secondary={value}
            secondaryTypographyProps={{ sx: { mt: 0.5, wordBreak: "break-all" }, variant: "body2" }}
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
        bgcolor: "background.default",
        border: 1,
        borderColor: "divider",
        fontFamily: "JetBrains Mono, Consolas, monospace",
        fontSize: 13,
        m: 0,
        overflowX: "auto",
        p: 2,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {code}
    </Box>
  );
}
