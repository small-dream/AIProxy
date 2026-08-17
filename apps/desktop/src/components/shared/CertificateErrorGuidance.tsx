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
  // Optional in-app navigation to the troubleshooting guide; rendered as an
  // "Open guide" action when provided. A callback (not a URL) so callers stay
  // in control of routing — the guide lives at /docs?doc=certificate-setup
  // inside the app, and a raw href would escape to the system browser.
  onOpenGuide?: () => void;
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
  desktopEnvUnsupported: "errorGuidance.reason.desktopEnvUnsupported",
  installerFailed: "errorGuidance.reason.installerFailed",
  generateFailed: "errorGuidance.reason.generateFailed",
  unknown: "errorGuidance.reason.unknown",
};

const STEP_KEYS: Record<CertificateErrorClass, TranslationKey> = {
  portInUse: "errorGuidance.steps.portInUse",
  certNotFound: "errorGuidance.steps.certNotFound",
  proxyNotRunning: "errorGuidance.steps.proxyNotRunning",
  permissionDenied: "errorGuidance.steps.permissionDenied",
  desktopEnvUnsupported: "errorGuidance.steps.desktopEnvUnsupported",
  installerFailed: "errorGuidance.steps.installerFailed",
  generateFailed: "errorGuidance.steps.generateFailed",
  unknown: "errorGuidance.steps.unknown",
};

export function CertificateErrorGuidance({ error, context, onRetry, onOpenGuide }: Props) {
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
      {(guidance.canRetry || onOpenGuide) && (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          {guidance.canRetry && onRetry && (
            <Button size="small" color="inherit" variant="outlined" onClick={onRetry}>
              {t("errorGuidance.actions.retry")}
            </Button>
          )}
          {onOpenGuide && (
            <Link component="button" onClick={onOpenGuide} underline="hover">
              {t("errorGuidance.actions.openGuide")}
            </Link>
          )}
        </Stack>
      )}
    </Alert>
  );
}
