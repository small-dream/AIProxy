import { Box, Stack, Typography } from "@mui/material";

import { SectionCard } from "@/components/shared/SectionCard";

export function RulesPage() {
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">Rules</Typography>
        <Typography color="text.secondary" variant="body1">
          Manage breakpoints, rewrite rules, and local or remote mappings from one place.
        </Typography>
      </Stack>

      <Box
        sx={{
          display: "grid",
          gap: 3,
          gridTemplateColumns: {
            md: "minmax(0, 4fr) minmax(0, 8fr)",
            xs: "1fr",
          },
        }}
      >
        <Box>
          <SectionCard
            description="Rule lists will be grouped by type and backed by the rule-engine crate."
            title="Rule Collections"
          >
            <Typography color="text.secondary" variant="body2">
              Breakpoint, rewrite, and map rules will be queryable through the shared command layer.
            </Typography>
          </SectionCard>
        </Box>

        <Box>
          <SectionCard
            description="Rule editing flows are intentionally centralized to keep validation logic consistent."
            title="Rule Editor"
          >
            <Typography color="text.secondary" variant="body2">
              Match expressions, priorities, and actions will be modeled through reusable form sections.
            </Typography>
          </SectionCard>
        </Box>
      </Box>
    </Stack>
  );
}

