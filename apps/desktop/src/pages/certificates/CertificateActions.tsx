import { Button, CircularProgress, Stack } from "@mui/material";
import { type CertificateStatus } from "@pharles/shared-types";

type Props = {
  status: CertificateStatus | undefined;
  generating: boolean;
  installing: boolean;
  onGenerate: () => void;
  onInstall: () => void;
  onRefresh: () => void;
  loading: boolean;
};

export function CertificateActions({ status, generating, installing, onGenerate, onInstall, onRefresh, loading }: Props) {
  const hasCert = !!status?.certPath;
  const isTrusted = status?.trusted ?? false;
  const isWindows = status?.platform === "windows";
  const showInstallButton = isWindows && hasCert && !isTrusted;

  return (
    <Stack direction="row" spacing={2}>
      <Button
        variant="contained"
        onClick={onGenerate}
        disabled={loading || generating || installing || (hasCert && isTrusted)}
        startIcon={generating ? <CircularProgress size={16} /> : undefined}
      >
        {generating ? "Generating..." : hasCert ? "Regenerate Root Certificate" : "Generate Root Certificate"}
      </Button>

      {showInstallButton && (
        <Button
          variant="contained"
          color="success"
          onClick={onInstall}
          disabled={loading || installing || generating}
          startIcon={installing ? <CircularProgress size={16} /> : undefined}
        >
          {installing ? "Opening..." : "Install Certificate..."}
        </Button>
      )}

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
