import { Box, Stack, Typography } from "@mui/material";

import { SectionCard } from "@/components/shared/SectionCard";

export function ComposePage() {
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">Compose</Typography>
        <Typography color="text.secondary" variant="body1">
          Build and replay requests without leaving the desktop workspace.
        </Typography>
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
        <Box>
          <SectionCard
            description="Method, URL, headers, and request body editors will live here."
            title="Request Builder"
          >
            <Typography color="text.secondary" variant="body2">
              Compose support will share DTOs with the proxy runtime to keep replay behavior predictable.
            </Typography>
          </SectionCard>
        </Box>

        <Box>
          <SectionCard
            description="A live response summary will appear after a request is sent."
            title="Response Preview"
          >
            <Typography color="text.secondary" variant="body2">
              Compose responses will reuse the same inspector primitives as captured sessions.
            </Typography>
          </SectionCard>
        </Box>
      </Box>
    </Stack>
  );
}
