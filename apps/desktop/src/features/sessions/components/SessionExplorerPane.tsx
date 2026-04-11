import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import LanguageRoundedIcon from "@mui/icons-material/LanguageRounded";
import SubdirectoryArrowRightRoundedIcon from "@mui/icons-material/SubdirectoryArrowRightRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import type { SessionSummary } from "@pharles/shared-types";

import type { SessionExplorerScope, SessionHostGroup } from "../session-explorer.helpers";

type SessionExplorerPaneProps = {
  errorMessage: string | undefined;
  expandedHosts: string[];
  groups: SessionHostGroup[];
  isLoading: boolean;
  onScopeChange: (scope: SessionExplorerScope) => void;
  onSelectSession: (sessionId: string) => void;
  onToggleHost: (host: string) => void;
  scope: SessionExplorerScope;
  selectedSessionId: string | undefined;
};

export function SessionExplorerPane({
  errorMessage,
  expandedHosts,
  groups,
  isLoading,
  onScopeChange,
  onSelectSession,
  onToggleHost,
  scope,
  selectedSessionId,
}: SessionExplorerPaneProps) {
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
      <Stack
        alignItems="center"
        direction="row"
        justifyContent="space-between"
        spacing={2}
        sx={{ borderBottom: 1, borderColor: "divider", px: 1.5, py: 1.25 }}
      >
        <Stack spacing={0.25}>
          <Typography variant="subtitle2">Session Explorer</Typography>
          <Typography color="text.secondary" variant="caption">
            Grouped by host for rapid traffic drilling.
          </Typography>
        </Stack>

        <ToggleButtonGroup
          exclusive
          onChange={(_event, nextScope: SessionExplorerScope | null) => {
            if (nextScope) {
              onScopeChange(nextScope);
            }
          }}
          size="small"
          value={scope}
        >
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="http">HTTP</ToggleButton>
          <ToggleButton value="errors">Errors</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {isLoading ? (
          <Stack alignItems="center" spacing={1.5} sx={{ px: 2, py: 6 }}>
            <CircularProgress size={24} />
            <Typography color="text.secondary" variant="body2">
              Loading captured sessions...
            </Typography>
          </Stack>
        ) : errorMessage ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">{errorMessage}</Alert>
          </Box>
        ) : groups.length === 0 ? (
          <Stack spacing={1} sx={{ p: 2.5 }}>
            <Typography variant="body2">No captured sessions yet.</Typography>
            <Typography color="text.secondary" variant="body2">
              Start the proxy, enable Windows system proxy, then open a plain HTTP page to populate the explorer tree.
            </Typography>
          </Stack>
        ) : (
          <List disablePadding>
            {groups.map((group, index) => {
              const expanded = expandedHosts.includes(group.host);

              return (
                <Box key={group.host}>
                  <ListItemButton dense onClick={() => onToggleHost(group.host)}>
                    {expanded ? <ExpandMoreRoundedIcon fontSize="small" /> : <ChevronRightRoundedIcon fontSize="small" />}
                    <LanguageRoundedIcon color="primary" fontSize="small" sx={{ ml: 0.5, mr: 1 }} />
                    <ListItemText
                      primary={group.host}
                      primaryTypographyProps={{ noWrap: true, variant: "body2" }}
                      secondary={`${group.totalCount} requests`}
                      secondaryTypographyProps={{ variant: "caption" }}
                    />
                    <Chip label={group.totalCount} size="small" variant="outlined" />
                  </ListItemButton>

                  {expanded ? (
                    <List disablePadding sx={{ pb: 0.5 }}>
                      {group.sessions.map((session) => (
                        <SessionLeafNode
                          key={session.id}
                          onClick={() => onSelectSession(session.id)}
                          selected={selectedSessionId === session.id}
                          session={session}
                        />
                      ))}
                    </List>
                  ) : null}

                  {index < groups.length - 1 ? <Divider component="li" /> : null}
                </Box>
              );
            })}
          </List>
        )}
      </Box>
    </Paper>
  );
}

type SessionLeafNodeProps = {
  onClick: () => void;
  selected: boolean;
  session: SessionSummary;
};

function SessionLeafNode({ onClick, selected, session }: SessionLeafNodeProps) {
  const statusColor = getStatusColor(session.statusCode);
  const displayPath = session.path.trim().length > 0 ? session.path : "/";

  return (
    <ListItemButton dense onClick={onClick} selected={selected} sx={{ pl: 4.5, pr: 1.5 }}>
      <SubdirectoryArrowRightRoundedIcon color="disabled" fontSize="small" sx={{ mr: 0.5 }} />
      <ListItemText
        primary={
          <Stack alignItems="center" direction="row" spacing={1}>
            <Chip color={statusColor} label={session.method} size="small" sx={{ minWidth: 54 }} variant="outlined" />
            <Typography noWrap variant="body2">
              {displayPath}
            </Typography>
            {session.statusCode >= 400 ? <WarningAmberRoundedIcon color="warning" fontSize="small" /> : null}
          </Stack>
        }
        secondary={`${session.statusCode} • ${session.durationMs} ms • ${session.protocol}`}
        secondaryTypographyProps={{ noWrap: true, variant: "caption" }}
      />
    </ListItemButton>
  );
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
