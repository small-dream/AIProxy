import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  Alert,
  Box,
  CircularProgress,
  Divider,
  List,
  ListItemButton,
  OutlinedInput,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type { SessionSummary } from "@pharles/shared-types";

import type { SessionHostGroup } from "../session-explorer.helpers";

type SessionExplorerPaneProps = {
  errorMessage: string | undefined;
  expandedHosts: string[];
  groups: SessionHostGroup[];
  isLoading: boolean;
  onSearchChange: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onToggleHost: (host: string) => void;
  searchValue: string;
  selectedSessionId: string | undefined;
};

export function SessionExplorerPane({
  errorMessage,
  expandedHosts,
  groups,
  isLoading,
  onSearchChange,
  onSelectSession,
  onToggleHost,
  searchValue,
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
      <Box sx={{ p: 1 }}>
        <OutlinedInput
          fullWidth
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search domain or path"
          size="small"
          startAdornment={<SearchRoundedIcon fontSize="small" sx={{ mr: 1 }} />}
          value={searchValue}
        />
      </Box>

      <Divider />

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {isLoading ? (
          <Stack alignItems="center" spacing={1.25} sx={{ px: 2, py: 5 }}>
            <CircularProgress size={22} />
            <Typography color="text.secondary" variant="body2">
              Loading captured sessions...
            </Typography>
          </Stack>
        ) : errorMessage ? (
          <Box sx={{ p: 1.5 }}>
            <Alert severity="error">{errorMessage}</Alert>
          </Box>
        ) : groups.length === 0 ? (
          <Stack spacing={0.75} sx={{ p: 2 }}>
            <Typography variant="body2">No captured sessions yet.</Typography>
            <Typography color="text.secondary" variant="body2">
              Start the proxy and open a plain HTTP page to populate the list.
            </Typography>
          </Stack>
        ) : (
          <List disablePadding>
            {groups.map((group, index) => {
              const expanded = expandedHosts.includes(group.host);

              return (
                <Box key={group.host}>
                  <ListItemButton dense onClick={() => onToggleHost(group.host)} sx={{ px: 1.25, py: 0.5 }}>
                    {expanded ? <ExpandMoreRoundedIcon fontSize="small" /> : <ChevronRightRoundedIcon fontSize="small" />}
                    <Typography noWrap sx={{ ml: 0.75 }} variant="body2">
                      {group.host}
                    </Typography>
                  </ListItemButton>

                  {expanded ? (
                    <List disablePadding sx={{ pb: 0.25 }}>
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
  const displayPath = session.path.trim().length > 0 ? session.path : "/";

  return (
    <ListItemButton dense onClick={onClick} selected={selected} sx={{ pl: 3.5, pr: 1.25, py: 0.375 }}>
      <Typography color={getRequestStateColor(session.statusCode)} sx={{ flex: "0 0 auto", mr: 0.75 }} variant="caption">
        {getRequestStateLabel(session.statusCode)}
      </Typography>
      <Typography noWrap variant="body2">
        {displayPath}
      </Typography>
    </ListItemButton>
  );
}

function getRequestStateLabel(statusCode: number): string {
  if (statusCode <= 0) {
    return "进行中";
  }

  if (statusCode >= 400) {
    return "失败";
  }

  return "成功";
}

function getRequestStateColor(statusCode: number): string {
  if (statusCode <= 0) {
    return "info.main";
  }

  if (statusCode >= 400) {
    return "error.main";
  }

  return "success.main";
}
