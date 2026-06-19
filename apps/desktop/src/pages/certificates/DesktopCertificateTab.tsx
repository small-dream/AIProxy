import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import { useState } from "react";
import {
  Button,
  Chip,
  CircularProgress,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Typography,
} from "@mui/material";
import { type CertificateStatus } from "@aiproxy/shared-types";
import { useDiagnoseCertificateSetup } from "@/features/certificate-center/use-certificate-status";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n, type TranslationKey } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

type Props = {
  status: CertificateStatus | undefined;
  loading: boolean;
  generating: boolean;
  installing: boolean;
  onGenerate: () => void;
  onInstall: () => void;
  onRefresh: () => void;
};

export function DesktopCertificateTab({
  status,
  loading,
  generating,
  installing,
  onGenerate,
  onInstall,
  onRefresh,
}: Props) {
  const { t } = useI18n();
  const hasCert = !!status?.certPath;
  const isTrusted = status?.trusted ?? false;
  const supportsInstaller =
    status?.platform === "windows" || status?.platform === "macos" || status?.platform === "linux";
  const showInstallButton = supportsInstaller && hasCert && !isTrusted;

  const activeStep = isTrusted ? 2 : hasCert ? 1 : 0;

  return (
    <Stack spacing={2}>
      <SectionCard
        title={t("certificatesPage.status.title")}
        toolbar={
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              size="small"
              onClick={onGenerate}
              disabled={loading || generating || installing || (hasCert && isTrusted)}
              startIcon={generating ? <CircularProgress size={16} /> : undefined}
            >
              {generating
                ? t("certificatesPage.actions.generating")
                : hasCert
                  ? t("certificatesPage.actions.regenerate")
                  : t("certificatesPage.actions.generate")}
            </Button>
            {showInstallButton && (
              <Button
                variant="contained"
                color="success"
                size="small"
                onClick={onInstall}
                disabled={loading || installing || generating}
                startIcon={installing ? <CircularProgress size={16} /> : undefined}
              >
                {installing
                  ? t("certificatesPage.actions.opening")
                  : t("certificatesPage.actions.install")}
              </Button>
            )}
            <Button
              variant="outlined"
              size="small"
              onClick={onRefresh}
              disabled={loading}
              startIcon={loading ? <CircularProgress size={16} /> : undefined}
            >
              {t("common.actions.refreshStatus")}
            </Button>
          </Stack>
        }
      >
        <Stack spacing={1.5}>
          {/* Compact workflow stepper */}
          <Stepper activeStep={activeStep} sx={{ mb: 1 }}>
            <Step completed={hasCert}>
              <StepLabel sx={{ "& .MuiStepLabel-label": { fontSize: 12 } }}>
                {t("certificatesPage.workflow.generate")}
              </StepLabel>
            </Step>
            <Step completed={isTrusted}>
              <StepLabel sx={{ "& .MuiStepLabel-label": { fontSize: 12 } }}>
                {t("certificatesPage.workflow.trust")}
              </StepLabel>
            </Step>
            <Step completed={hasCert && isTrusted}>
              <StepLabel sx={{ "& .MuiStepLabel-label": { fontSize: 12 } }}>
                {t("certificatesPage.workflow.ready")}
              </StepLabel>
            </Step>
          </Stepper>

          {/* Status rows */}
          <Stack direction="row" spacing={2} sx={{
            alignItems: "center"
          }}>
            <Typography variant="body2" sx={{ minWidth: 100, color: "text.secondary" }}>
              {t("certificatesPage.status.rootCertificate")}
            </Typography>
            {loading ? (
              <Chip label={t("common.states.checking")} size="small" />
            ) : hasCert ? (
              <Chip label={t("common.states.present")} color="success" size="small" />
            ) : (
              <Chip
                label={t("certificatesPage.status.notGenerated")}
                color="warning"
                size="small"
              />
            )}
          </Stack>

          <Stack direction="row" spacing={2} sx={{
            alignItems: "center"
          }}>
            <Typography variant="body2" sx={{ minWidth: 100, color: "text.secondary" }}>
              {t("certificatesPage.status.trusted")}
            </Typography>
            {loading ? (
              <Chip label={t("common.states.checking")} size="small" />
            ) : isTrusted ? (
              <Chip label={t("common.states.trusted")} color="success" size="small" />
            ) : (
              <Chip label={t("common.states.notTrusted")} color="error" size="small" />
            )}
          </Stack>

          {status?.fingerprint ? (
            <Stack direction="row" spacing={2} sx={{
              alignItems: "center"
            }}>
              <Typography variant="body2" sx={{ minWidth: 100, color: "text.secondary" }}>
                {t("certificatesPage.status.fingerprint")}
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontFamily: fontFamilies.mono, fontSize: "0.8rem", wordBreak: "break-all" }}
              >
                {status.fingerprint}
              </Typography>
            </Stack>
          ) : null}

          {status?.certPath ? (
            <Stack direction="row" spacing={2} sx={{
              alignItems: "center"
            }}>
              <Typography variant="body2" sx={{ minWidth: 100, color: "text.secondary" }}>
                {t("certificatesPage.status.certificatePath")}
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontFamily: fontFamilies.mono, fontSize: "0.8rem", wordBreak: "break-all" }}
              >
                {status.certPath}
              </Typography>
            </Stack>
          ) : null}

          <Stack direction="row" spacing={2} sx={{
            alignItems: "center"
          }}>
            <Typography variant="body2" sx={{ minWidth: 100, color: "text.secondary" }}>
              {t("certificatesPage.status.platform")}
            </Typography>
            <Typography variant="body2">
              {status?.platform ?? t("common.states.unknown")}
            </Typography>
          </Stack>
        </Stack>
      </SectionCard>
      <DiagnosticsCard />
    </Stack>
  );
}

const DIAGNOSTIC_CHECK_KEYS: Record<string, TranslationKey> = {
  cert_present: "certificatesPage.diagnostics.checks.cert_present",
  cert_trusted: "certificatesPage.diagnostics.checks.cert_trusted",
  adb: "certificatesPage.diagnostics.checks.adb",
  ios_simulator: "certificatesPage.diagnostics.checks.ios_simulator",
};

// Advanced, on-demand environment check backed by `diagnose_certificate_setup`.
// Surfaces cert presence/trust, adb, and iOS Simulator tooling so users can
// self-diagnose "installed but not capturing" situations.
function DiagnosticsCard() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const { data, isFetching, refetch } = useDiagnoseCertificateSetup({ enabled });

  const handleRun = () => {
    if (!enabled) {
      setEnabled(true);
    }
    void refetch();
  };

  const checks = data?.checks ?? [];
  const passed = checks.filter((check) => check.ok).length;

  return (
    <SectionCard
      title={t("certificatesPage.diagnostics.title")}
      toolbar={
        <Button
          variant="outlined"
          size="small"
          onClick={handleRun}
          disabled={isFetching}
          startIcon={isFetching ? <CircularProgress size={16} /> : undefined}
        >
          {isFetching
            ? t("certificatesPage.diagnostics.running")
            : t("certificatesPage.diagnostics.run")}
        </Button>
      }
    >
      {data ? (
        <Stack spacing={1}>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("certificatesPage.diagnostics.summary", { passed, total: checks.length })}
          </Typography>
          {checks.map((check) => {
            const Icon = check.ok ? CheckCircleRoundedIcon : ErrorOutlineRoundedIcon;
            const labelKey = DIAGNOSTIC_CHECK_KEYS[check.key];
            return (
              <Stack key={check.key} direction="row" spacing={1} sx={{
                alignItems: "start"
              }}>
                <Icon
                  sx={{ fontSize: 18, mt: 0.25, color: check.ok ? "success.main" : "error.main" }}
                />
                <Stack spacing={0.25}>
                  <Typography variant="body2">{labelKey ? t(labelKey) : check.key}</Typography>
                  {check.message && !check.ok && (
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>
                      {check.message}
                    </Typography>
                  )}
                </Stack>
              </Stack>
            );
          })}
        </Stack>
      ) : (
        <Typography variant="body2" sx={{
          color: "text.secondary"
        }}>
          {t("certificatesPage.diagnostics.hint")}
        </Typography>
      )}
    </SectionCard>
  );
}
