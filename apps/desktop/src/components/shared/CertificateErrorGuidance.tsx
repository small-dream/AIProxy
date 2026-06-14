import { Alert, AlertTitle, Button, Link, Stack } from "@mui/material";

import {
  mapCertificateError,
  type CertificateErrorClass,
  type CertificateErrorContext,
} from "@/features/certificate-center/error-guidance";
import { useI18n, type TranslationKey } from "@/i18n";

type Props = {
  error: unknown;
  context: CertificateErrorContext;
  onRetry?: () => void;
  // Optional troubleshooting-guide URL; rendered as an "Open guide" link when provided.
  guideUrl?: string;
};

// Page-level authoritative guidance for certificate/proxy action failures inside
// the guided flow. Consumes the pure mapCertificateError classifier and maps the
// stable errorClass to localized reason + steps. The command layer keeps logging
// the error; this component is the actionable UI the user sees.
const REASON_KEYS: Record<CertificateErrorClass, TranslationKey> = {
  portInUse: "errorGuidance.reason.portInUse",
  certNotFound: "errorGuidance.reason.certNotFound",
  proxyNotRunning: "errorGuidance.reason.proxyNotRunning",
  permissionDenied: "errorGuidance.reason.permissionDenied",
  installerFailed: "errorGuidance.reason.installerFailed",
  generateFailed: "errorGuidance.reason.generateFailed",
  unknown: "errorGuidance.reason.unknown",
};

const STEP_KEYS: Record<CertificateErrorClass, TranslationKey> = {
  portInUse: "errorGuidance.steps.portInUse",
  certNotFound: "errorGuidance.steps.certNotFound",
  proxyNotRunning: "errorGuidance.steps.proxyNotRunning",
  permissionDenied: "errorGuidance.steps.permissionDenied",
  installerFailed: "errorGuidance.steps.installerFailed",
  generateFailed: "errorGuidance.steps.generateFailed",
  unknown: "errorGuidance.steps.unknown",
};

export function CertificateErrorGuidance({ error, context, onRetry, guideUrl }: Props) {
  const { t, tList } = useI18n();
  const guidance = mapCertificateError(error, context);
  const steps = tList(STEP_KEYS[guidance.errorClass]);

  return (
    <Alert severity="error" variant="filled">
      <AlertTitle>{t(REASON_KEYS[guidance.errorClass])}</AlertTitle>
      <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.25 }}>
        {steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </Stack>
      {(guidance.canRetry || guideUrl) && (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          {guidance.canRetry && onRetry && (
            <Button size="small" color="inherit" variant="outlined" onClick={onRetry}>
              {t("errorGuidance.actions.retry")}
            </Button>
          )}
          {guideUrl && (
            <Link href={guideUrl} target="_blank" rel="noreferrer" underline="hover">
              {t("errorGuidance.actions.openGuide")}
            </Link>
          )}
        </Stack>
      )}
    </Alert>
  );
}
