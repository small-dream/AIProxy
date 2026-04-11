import { DEFAULT_PROXY_PORT, DEFAULT_WORKSPACE_ID } from "@pharles/shared-types";
import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";

import { ProxyStatusCard } from "@/components/shared/ProxyStatusCard";
import { SectionCard } from "@/components/shared/SectionCard";
import { useProxyStatus, useStartProxy, useStopProxy } from "@/features/proxy-status/use-proxy-status";

export function SessionsPage() {
  const { data: proxyStatus, error, isLoading } = useProxyStatus();
  const startProxyMutation = useStartProxy();
  const stopProxyMutation = useStopProxy();

  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const port = proxyStatus?.port ?? DEFAULT_PROXY_PORT;
  const isBusy = startProxyMutation.isPending || stopProxyMutation.isPending;

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
              onStart={() =>
                startProxyMutation.mutate({
                  enableSsl: proxyStatus?.sslEnabled ?? false,
                  port,
                  workspaceId,
                })
              }
              onStop={() => stopProxyMutation.mutate(workspaceId)}
              port={port}
              sslEnabled={proxyStatus?.sslEnabled ?? false}
              workspaceId={workspaceId}
            />

            <SectionCard
              description="The virtualized session table will be connected to the live proxy event stream."
              title="Capture Stream"
            >
              {isLoading ? (
                <Stack alignItems="center" direction="row" spacing={1.5}>
                  <CircularProgress size={18} />
                  <Typography color="text.secondary" variant="body2">
                    Loading bootstrap status...
                  </Typography>
                </Stack>
              ) : (
                <Typography color="text.secondary" variant="body2">
                  No sessions yet. Once the proxy runtime is connected, captured traffic will appear here.
                </Typography>
              )}
            </SectionCard>
          </Stack>
        </Box>

        <Box>
          <SectionCard
            description="Request, response, timing, cookie, and raw inspectors will share this panel."
            title="Inspector"
          >
            <Stack spacing={2}>
              {error ? (
                <Alert severity="error">
                  Unable to load proxy bootstrap status. The UI is showing fallback placeholders until the command layer
                  is available.
                </Alert>
              ) : null}
              <Typography color="text.secondary" variant="body2">
                Select a session to inspect headers, body content, timings, and replay actions.
              </Typography>
            </Stack>
          </SectionCard>
        </Box>
      </Box>
    </Stack>
  );
}
