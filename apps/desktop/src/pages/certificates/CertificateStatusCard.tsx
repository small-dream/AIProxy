import { Chip, Stack, Typography } from "@mui/material";
import { type CertificateStatus } from "@pharles/shared-types";
import { SectionCard } from "@/components/shared/SectionCard";

type Props = {
  status: CertificateStatus | undefined;
  loading: boolean;
};

export function CertificateStatusCard({ status, loading }: Props) {
  const hasCert = !!status?.certPath;
  const isTrusted = status?.trusted ?? false;

  return (
    <SectionCard title="Certificate Status" description="Root CA certificate state and trust status.">
      <Stack spacing={2}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="body2" sx={{ minWidth: 120 }}>Root Certificate:</Typography>
          {loading ? (
            <Chip label="Checking..." size="small" />
          ) : hasCert ? (
            <Chip label="Present" color="success" size="small" />
          ) : (
            <Chip label="Not Generated" color="warning" size="small" />
          )}
        </Stack>

        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="body2" sx={{ minWidth: 120 }}>Trusted:</Typography>
          {loading ? (
            <Chip label="Checking..." size="small" />
          ) : isTrusted ? (
            <Chip label="Trusted" color="success" size="small" />
          ) : (
            <Chip label="Not Trusted" color="error" size="small" />
          )}
        </Stack>

        {status?.fingerprint ? (
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>Fingerprint:</Typography>
            <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}>
              {status.fingerprint}
            </Typography>
          </Stack>
        ) : null}

        {status?.certPath ? (
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>Certificate Path:</Typography>
            <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}>
              {status.certPath}
            </Typography>
          </Stack>
        ) : null}

        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="body2" sx={{ minWidth: 120 }}>Platform:</Typography>
          <Typography variant="body2">{status?.platform ?? "unknown"}</Typography>
        </Stack>
      </Stack>
    </SectionCard>
  );
}
