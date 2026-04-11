import { Box, Button, Stack, Typography } from "@mui/material";

import { SectionCard } from "@/components/shared/SectionCard";

export function SessionsPage() {
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
          <SectionCard
            description="The virtualized session table will be connected to the live proxy event stream."
            title="Capture Stream"
            toolbar={<Button variant="contained">Start Proxy</Button>}
          >
            <Typography color="text.secondary" variant="body2">
              No sessions yet. Once the proxy runtime is connected, captured traffic will appear here.
            </Typography>
          </SectionCard>
        </Box>

        <Box>
          <SectionCard
            description="Request, response, timing, cookie, and raw inspectors will share this panel."
            title="Inspector"
          >
            <Typography color="text.secondary" variant="body2">
              Select a session to inspect headers, body content, timings, and replay actions.
            </Typography>
          </SectionCard>
        </Box>
      </Box>
    </Stack>
  );
}
