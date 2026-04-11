import { DEFAULT_PROXY_PORT, DEFAULT_WORKSPACE_ID } from "@pharles/shared-types";
import {
  Alert,
  Box,
  CircularProgress,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";

import { ProxyStatusCard } from "@/components/shared/ProxyStatusCard";
import { SectionCard } from "@/components/shared/SectionCard";
import {
  useDisableSystemProxy,
  useEnableSystemProxy,
  useProxyStatus,
  useStartProxy,
  useStopProxy,
} from "@/features/proxy-status/use-proxy-status";
import { useSessions } from "@/features/sessions/use-sessions";

export function SessionsPage() {
  const { data: proxyStatus, error, isLoading } = useProxyStatus();
  const startProxyMutation = useStartProxy();
  const stopProxyMutation = useStopProxy();
  const enableSystemProxyMutation = useEnableSystemProxy();
  const disableSystemProxyMutation = useDisableSystemProxy();
  const { data: sessions = [], isLoading: areSessionsLoading } = useSessions(proxyStatus?.running ?? false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();

  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const port = proxyStatus?.port ?? DEFAULT_PROXY_PORT;
  const isBusy =
    startProxyMutation.isPending ||
    stopProxyMutation.isPending ||
    enableSystemProxyMutation.isPending ||
    disableSystemProxyMutation.isPending;
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? sessions[0],
    [selectedSessionId, sessions],
  );

  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">Sessions</Typography>
        <Typography color="text.secondary" variant="body1">
          Main capture workspace for real-time proxy traffic and detailed inspection.
        </Typography>
      </Stack>

      <Box
        sx={{
          display: "grid",
          gap: 3,
          gridTemplateColumns: {
            md: "minmax(0, 7fr) minmax(0, 5fr)",
            xs: "1fr",
          },
        }}
      >
        <Box>
          <Stack spacing={3}>
            <ProxyStatusCard
              busy={isBusy}
              isRunning={proxyStatus?.running ?? false}
              onDisableSystemProxy={() => disableSystemProxyMutation.mutate()}
              onEnableSystemProxy={() => enableSystemProxyMutation.mutate()}
              onStart={() =>
                startProxyMutation.mutate({
                  enableSsl: false,
                  port,
                  workspaceId,
                })
              }
              onStop={() => stopProxyMutation.mutate(workspaceId)}
              port={port}
              systemProxyEnabled={proxyStatus?.systemProxyEnabled ?? false}
              sslEnabled={false}
              workspaceId={workspaceId}
            />

            <SectionCard
              description="Configure your browser or system HTTP proxy to 127.0.0.1 and the active port to capture plain HTTP traffic."
              title="Capture Stream"
            >
              {isLoading || areSessionsLoading ? (
                <Stack alignItems="center" direction="row" spacing={1.5}>
                  <CircularProgress size={18} />
                  <Typography color="text.secondary" variant="body2">
                    Loading proxy state and captured sessions...
                  </Typography>
                </Stack>
              ) : sessions.length > 0 ? (
                <List disablePadding>
                  {sessions.map((session) => (
                    <ListItemButton
                      key={session.id}
                      onClick={() => setSelectedSessionId(session.id)}
                      selected={selectedSession?.id === session.id}
                    >
                      <ListItemText
                        primary={`${session.method} ${session.host}${session.path}`}
                        secondary={`${session.statusCode} • ${session.durationMs} ms • ${session.sizeBytes} bytes`}
                      />
                    </ListItemButton>
                  ))}
                </List>
              ) : (
                <Stack spacing={1}>
                  <Typography color="text.secondary" variant="body2">
                    No sessions yet. Start the proxy, then point your browser to `127.0.0.1:{port}` as an HTTP proxy.
                  </Typography>
                  <Typography color="text.secondary" variant="body2">
                    HTTPS CONNECT interception will come in the next phase. This milestone captures plain HTTP requests.
                  </Typography>
                </Stack>
              )}
            </SectionCard>
          </Stack>
        </Box>

        <Box>
          <SectionCard
            description="This panel shows the selected session summary while the detailed inspector is still being built."
            title="Inspector"
          >
            <Stack spacing={2}>
              {error ? (
                <Alert severity="error">
                  Unable to load proxy bootstrap status. The UI is showing fallback placeholders until the command layer
                  is available.
                </Alert>
              ) : null}
              {selectedSession ? (
                <Stack spacing={1}>
                  <Typography variant="body2">Method: {selectedSession.method}</Typography>
                  <Typography variant="body2">Host: {selectedSession.host}</Typography>
                  <Typography variant="body2">Path: {selectedSession.path}</Typography>
                  <Typography variant="body2">Status: {selectedSession.statusCode}</Typography>
                  <Typography variant="body2">Duration: {selectedSession.durationMs} ms</Typography>
                  <Typography variant="body2">Size: {selectedSession.sizeBytes} bytes</Typography>
                  <Typography sx={{ wordBreak: "break-all" }} variant="body2">
                    URL: {selectedSession.url}
                  </Typography>
                </Stack>
              ) : (
                <Typography color="text.secondary" variant="body2">
                  Select a captured HTTP session to inspect its summary details.
                </Typography>
              )}
            </Stack>
          </SectionCard>
        </Box>
      </Box>
    </Stack>
  );
}
