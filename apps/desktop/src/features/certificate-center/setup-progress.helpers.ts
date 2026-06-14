import { DEFAULT_WORKSPACE_ID, type CertificateStatus, type ProxyStatus } from "@aiproxy/shared-types";

// Ordered setup checklist. The first incomplete step becomes `nextAction`.
export type SetupStepKey =
  | "certGenerated"
  | "certTrusted"
  | "proxyRunning"
  | "sslDecryption"
  | "systemProxyOrManual";

// Persisted "user chose to configure the proxy manually" acknowledgement.
// Bound to a port+workspace so it invalidates when either changes, preventing
// a stale acknowledgement from masking a regressed proxy configuration.
export type ManualProxyAck = {
  port: number;
  workspaceId: string;
  acknowledgedAt: string;
};

export type SetupProgress = {
  certGenerated: boolean;
  certTrusted: boolean;
  httpsReady: boolean;
  proxyRunning: boolean;
  sslEnabled: boolean;
  systemProxyOn: boolean;
  manualProxyStillValid: boolean;
  proxySatisfied: boolean;
  captureReady: boolean;
  steps: Record<SetupStepKey, boolean>;
  nextAction: SetupStepKey | null;
};

const STEP_ORDER: readonly SetupStepKey[] = [
  "certGenerated",
  "certTrusted",
  "proxyRunning",
  "sslDecryption",
  "systemProxyOrManual",
];

// Derives the full setup state machine from existing hooks. No new backend state:
// everything comes from `useCertificateStatus()` + `useProxyStatus()` + the
// persisted manual-proxy acknowledgement. The terminal goal is `captureReady`
// ("the user can capture their first HTTPS request"), not just `httpsReady`.
export function computeSetupProgress(
  certStatus: CertificateStatus | undefined,
  proxyStatus: ProxyStatus | undefined,
  manualProxyAcknowledgedFor: ManualProxyAck | undefined,
): SetupProgress {
  const certGenerated = !!certStatus?.certPath;
  const certTrusted = !!certStatus?.trusted;
  const httpsReady = certGenerated && certTrusted;

  const proxyRunning = !!proxyStatus?.running;
  const sslEnabled = !!proxyStatus?.sslEnabled;
  const systemProxyOn = !!proxyStatus?.systemProxyEnabled;
  const manualProxyStillValid = isManualProxyAckValid(manualProxyAcknowledgedFor, proxyStatus);

  const proxySatisfied = proxyRunning && (systemProxyOn || manualProxyStillValid);
  // SSL decryption must be on, otherwise the proxy only forwards HTTPS without
  // decrypting it — captureReady must not claim HTTPS capture is possible.
  const captureReady = httpsReady && sslEnabled && proxySatisfied;

  const steps: Record<SetupStepKey, boolean> = {
    certGenerated,
    certTrusted,
    proxyRunning,
    sslDecryption: sslEnabled,
    systemProxyOrManual: systemProxyOn || manualProxyStillValid,
  };

  const nextAction = STEP_ORDER.find((step) => !steps[step]) ?? null;

  return {
    certGenerated,
    certTrusted,
    httpsReady,
    proxyRunning,
    sslEnabled,
    systemProxyOn,
    manualProxyStillValid,
    proxySatisfied,
    captureReady,
    steps,
    nextAction,
  };
}

function isManualProxyAckValid(
  ack: ManualProxyAck | undefined,
  proxyStatus: ProxyStatus | undefined,
): boolean {
  if (!ack || !proxyStatus) {
    return false;
  }

  const activeWorkspaceId = proxyStatus.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  return ack.port === proxyStatus.port && ack.workspaceId === activeWorkspaceId;
}

export type SetupWizardGateInput = {
  setupWizardCompleted: boolean;
  setupWizardDismissedAt: string | undefined;
  captureReady: boolean;
};

// The modal wizard shows once for a fresh user who has neither dismissed it,
// completed it, nor reached captureReady. After a dismiss/complete it never
// auto-reshows; a later regression (cert deleted, proxy stopped) is handled by
// the persistent checklist instead of re-nagging the user with a modal.
export function shouldShowSetupWizard(input: SetupWizardGateInput): boolean {
  return (
    !input.setupWizardCompleted && !input.setupWizardDismissedAt && !input.captureReady
  );
}
