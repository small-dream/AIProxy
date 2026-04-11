import { Stack, Typography } from "@mui/material";

import { SectionCard } from "@/components/shared/SectionCard";

export function CertificatesPage() {
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4">Certificates</Typography>
        <Typography color="text.secondary" variant="body1">
          Prepare HTTPS decryption and platform trust flows before capturing secure traffic.
        </Typography>
      </Stack>

      <SectionCard
        description="Platform-specific trust guidance and root certificate state will be wired to the TLS manager."
        title="Certificate Center"
      >
        <Typography color="text.secondary" variant="body2">
          The next milestone will connect this page to root certificate generation, trust detection, and troubleshooting.
        </Typography>
      </SectionCard>
    </Stack>
  );
}

