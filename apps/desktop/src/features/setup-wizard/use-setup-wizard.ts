import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { useCertificateStatus } from "@/features/certificate-center/use-certificate-status";
import {
  computeSetupProgress,
  shouldShowSetupWizard,
  type SetupProgress,
} from "@/features/certificate-center/setup-progress.helpers";
import { useProxyStartStore } from "@/features/proxy-status/proxy-start.store";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";

// Wires the (already unit-tested) pure state machine to live hook data and the
// persisted wizard flags. Consumed by the SetupWizard modal, the persistent
// SetupChecklistCard, and the status bar chip — one source of truth for all three.
export function useSetupWizard(): {
  progress: SetupProgress;
  setupWizardCompleted: boolean;
  // Modal wizard: shown once for a fresh user, never auto-reshown after
  // dismiss/complete even if captureReady later regresses.
  shouldShowWizard: boolean;
  // Persistent checklist: shown whenever the user cannot yet capture traffic,
  // regardless of dismiss/complete state. Honest reflection of current state.
  shouldShowChecklist: boolean;
  manualProxyAcknowledgedFor:
    | {
        port: number;
        workspaceId: string;
        acknowledgedAt: string;
      }
    | undefined;
  acknowledgeManualProxy: (port: number, workspaceId: string) => void;
  dismiss: () => void;
  complete: () => void;
} {
  const { data: certStatus, isLoading: certStatusLoading } = useCertificateStatus();
  const { data: proxyStatus, isLoading: proxyStatusLoading } = useProxyStatus();

  const setupWizardCompleted = useAppPreferencesStore((s) => s.setupWizardCompleted);
  const setupWizardDismissedAt = useAppPreferencesStore((s) => s.setupWizardDismissedAt);
  const manualProxyAcknowledgedFor = useAppPreferencesStore((s) => s.manualProxyAcknowledgedFor);
  const markSetupWizardCompleted = useAppPreferencesStore((s) => s.markSetupWizardCompleted);
  const dismissSetupWizard = useAppPreferencesStore((s) => s.dismissSetupWizard);
  const acknowledgeManualProxyInStore = useAppPreferencesStore((s) => s.acknowledgeManualProxy);

  const progress = computeSetupProgress(certStatus, proxyStatus, manualProxyAcknowledgedFor);

  // Suppress first-run guidance until the real status is available: while the
  // cert/proxy status is still loading (undefined → captureReady=false) and
  // while the app auto-starts the proxy on launch (captureReady stays false
  // until startProxy + enableSystemProxy finish). Without this the checklist
  // and wizard flash on every launch.
  const autoStartInProgress = useProxyStartStore((s) => s.autoStartInProgress);
  const guidanceSuppressed = certStatusLoading || proxyStatusLoading || autoStartInProgress;

  const shouldShowWizard =
    !guidanceSuppressed &&
    shouldShowSetupWizard({
      setupWizardCompleted,
      setupWizardDismissedAt,
      captureReady: progress.captureReady,
    });

  return {
    progress,
    setupWizardCompleted,
    shouldShowWizard,
    shouldShowChecklist: !guidanceSuppressed && !progress.captureReady,
    manualProxyAcknowledgedFor,
    acknowledgeManualProxy: (port, workspaceId) =>
      acknowledgeManualProxyInStore({
        port,
        workspaceId,
        acknowledgedAt: new Date().toISOString(),
      }),
    dismiss: () => dismissSetupWizard(new Date().toISOString()),
    complete: () => markSetupWizardCompleted(),
  };
}
