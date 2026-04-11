import { Stack, Typography } from "@mui/material";

import { SectionCard } from "@/components/shared/SectionCard";

export function WorkspacesPage() {
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">Workspaces</Typography>
        <Typography color="text.secondary" variant="body1">
          Project-scoped storage, proxy settings, and reusable rule presets will be organized here.
        </Typography>
      </Stack>

      <SectionCard
        description="Workspace selection will become the main unit for local state, session storage, and environment presets."
        title="Workspace Manager"
      >
        <Typography color="text.secondary" variant="body2">
          Create, load, and switch isolated debugging contexts without mixing sessions or rules between projects.
        </Typography>
      </SectionCard>
    </Stack>
  );
}

