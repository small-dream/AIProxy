import { Stack, Typography } from "@mui/material";

import { SectionCard } from "@/components/shared/SectionCard";

export function SettingsPage() {
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">Settings</Typography>
        <Typography color="text.secondary" variant="body1">
          Global preferences for appearance, proxy defaults, storage, and advanced runtime behavior.
        </Typography>
      </Stack>

      <SectionCard
        description="Application-wide defaults will be stored independently from workspace-specific behavior."
        title="Application Settings"
      >
        <Typography color="text.secondary" variant="body2">
          Theme mode, default ports, retention rules, shortcuts, and advanced diagnostics will be configured here.
        </Typography>
      </SectionCard>
    </Stack>
  );
}

