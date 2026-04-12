import { Button, CircularProgress, Stack } from "@mui/material";
import { type CertificateStatus } from "@pharles/shared-types";

type Props = {
  status: CertificateStatus | undefined;
  generating: boolean;
  onGenerate: () => void;
  onRefresh: () => void;
  loading: boolean;
};

export function CertificateActions({ status, generating, onGenerate, onRefresh, loading }: Props) {
  const hasCert = !!status?.certPath;
  const isTrusted = status?.trusted ?? false;

  return (
    <Stack direction="row" spacing={2}>
      <Button
        variant="contained"
        onClick={onGenerate}
        disabled={loading || generating || (hasCert && isTrusted)}
        startIcon={generating ? <CircularProgress size={16} /> : undefined}
      >
        {generating ? "Generating..." : hasCert ? "Regenerate Root Certificate" : "Generate Root Certificate"}
      </Button>

      <Button
        variant="outlined"
        onClick={onRefresh}
        disabled={loading}
        startIcon={loading ? <CircularProgress size={16} /> : undefined}
      >
        Refresh Status
      </Button>
    </Stack>
  );
}
