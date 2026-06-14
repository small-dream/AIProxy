import { openUrl } from "@tauri-apps/plugin-opener";
import { DEFAULT_PROXY_PORT } from "@aiproxy/shared-types";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { CertificateErrorGuidance } from "@/components/shared/CertificateErrorGuidance";
import {
  useCertificateStatus,
  useGenerateRootCertificate,
  useLaunchCertificateInstaller,
} from "@/features/certificate-center/use-certificate-status";
import { useProxyStartDefaults } from "@/features/proxy-status/use-proxy-start-defaults";
import { useEnableSystemProxy, useProxyStatus, useStartProxy, useStopProxy } from "@/features/proxy-status/use-proxy-status";
import { useSessions } from "@/features/sessions/use-sessions";
import { useI18n } from "@/i18n";

import { SetupWizardStepContent, type WizardStep } from "./SetupWizardSteps";
import { useSetupWizard } from "./use-setup-wizard";

const STEP_ORDER: readonly WizardStep[] = [
  "welcome",
  "generate",
  "install",
  "verifyTrust",
  "startProxy",
  "sslDecryption",
  "routing",
  "verifyTraffic",
  "complete",
];

const TEST_SITE_URL = "https://example.com";

type ActionContext = "generate" | "install" | "startProxy" | "enableSystemProxy";

export function SetupWizard() {
  const { t } = useI18n();
  const navigate = useNavigate();

  const {
    progress,
    setupWizardCompleted,
    shouldShowWizard,
    acknowledgeManualProxy,
    dismiss,
    complete,
  } = useSetupWizard();

  const { data: certStatus, refetch: refetchCertStatus } = useCertificateStatus();
  const generateMutation = useGenerateRootCertificate();
  const installMutation = useLaunchCertificateInstaller();
  const { data: proxyStatus } = useProxyStatus();
  const startProxyMutation = useStartProxy();
  const stopProxyMutation = useStopProxy();
  const enableSystemMutation = useEnableSystemProxy();
  const startDefaults = useProxyStartDefaults();
  const { data: sessions = [] } = useSessions();

  const [open, setOpen] = useState(false);
  const [activeStep, setActiveStep] = useState<WizardStep>("welcome");
  // Last action error rendered as page-level guidance inside the current step.
  const [actionError, setActionError] = useState<{ error: unknown; context: ActionContext } | null>(null);
  // Becomes true when the verify-trust step polls for too long without trust,
  // surfacing recovery actions (back / reopen installer / open certificates).
  const [verifyTrustStuck, setVerifyTrustStuck] = useState(false);

  const certTrusted = !!certStatus?.trusted;
  const hasFirstTraffic = sessions.length > 0;

  // Open the modal for a fresh user who hasn't completed/dismissed and isn't yet
  // captureReady. Once open it stays open until the user finishes or skips, even
  // if captureReady is reached mid-flow (so verifyTraffic can still run).
  useEffect(() => {
    if (shouldShowWizard && !open) {
      setOpen(true);
    }
  }, [shouldShowWizard, open]);

  // For a returning user who is already captureReady but was never marked
  // completed/dismissed, mark them completed so a later regression never
  // re-shows the modal — the persistent checklist handles recovery instead.
  // Guarded by setupWizardCompleted so it writes at most once (complete() is
  // recreated each render; without the guard this effect would re-fire).
  useEffect(() => {
    if (!open && progress.captureReady && !setupWizardCompleted) {
      complete();
    }
  }, [open, progress.captureReady, setupWizardCompleted, complete]);

  // Verify-trust step: poll certificate status until trusted, then advance.
  useEffect(() => {
    if (activeStep !== "verifyTrust" || certTrusted) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void refetchCertStatus();
    }, 2000);

    return () => window.clearInterval(interval);
  }, [activeStep, certTrusted, refetchCertStatus]);

  useEffect(() => {
    if (activeStep === "verifyTrust" && certTrusted) {
      setActiveStep("startProxy");
    }
  }, [activeStep, certTrusted]);

  // Surface recovery actions if trust isn't detected within a short window —
  // this is the most common place new users get stuck (wrong store, skipped
  // trust toggle, etc.). Resets whenever we leave the step or trust appears.
  useEffect(() => {
    if (activeStep !== "verifyTrust" || certTrusted) {
      setVerifyTrustStuck(false);
      return undefined;
    }

    const timeout = window.setTimeout(() => setVerifyTrustStuck(true), 15_000);
    return () => window.clearTimeout(timeout);
  }, [activeStep, certTrusted]);

  // Reopen the wizard on demand from the Help menu. The first-run auto-open
  // gate (shouldShowWizard) never fires for a returning user who is already
  // captureReady, so this imperative path lets them re-run the guide anytime.
  useEffect(() => {
    const openWizard = () => {
      setActiveStep("welcome");
      setActionError(null);
      setOpen(true);
    };
    window.addEventListener("aiproxy-menu-setup-wizard", openWizard);
    return () => window.removeEventListener("aiproxy-menu-setup-wizard", openWizard);
  }, []);

  const goNext = () => {
    setActionError(null);
    setActiveStep((current) => {
      const index = STEP_ORDER.indexOf(current);
      const next = STEP_ORDER[Math.min(index + 1, STEP_ORDER.length - 1)];
      return next ?? current;
    });
  };

  const goBack = () => {
    setActionError(null);
    setActiveStep((current) => {
      const index = STEP_ORDER.indexOf(current);
      const previous = STEP_ORDER[Math.max(index - 1, 0)];
      return previous ?? current;
    });
  };

  const handleGenerate = () => {
    setActionError(null);
    generateMutation.mutate(undefined, {
      onSuccess: () => goNext(),
      onError: (error) => setActionError({ error, context: "generate" }),
    });
  };

  const handleOpenInstaller = () => {
    setActionError(null);
    installMutation.mutate(undefined, {
      onError: (error) => setActionError({ error, context: "install" }),
    });
  };

  const handleStartProxy = () => {
    setActionError(null);
    // The wizard's whole point is HTTPS capture, so always start with SSL on.
    startProxyMutation.mutate(
      { ...startDefaults, enableSsl: true },
      {
        onSuccess: () => goNext(),
        onError: (error) => setActionError({ error, context: "startProxy" }),
      },
    );
  };

  // SSL-decryption step recovery: restart the proxy with SSL on. Used when the
  // proxy was started elsewhere as HTTP-only (e.g. a non-default workspace).
  const handleEnableSsl = async () => {
    setActionError(null);
    // Prefer the live active workspace over startDefaults — they usually match,
    // but during a transient workspace/status load they may diverge.
    const workspaceId = proxyStatus?.activeWorkspaceId ?? startDefaults.workspaceId;
    try {
      if (proxyStatus?.running) {
        await stopProxyMutation.mutateAsync(workspaceId);
      }
      await startProxyMutation.mutateAsync({ ...startDefaults, enableSsl: true });
      goNext();
    } catch (error) {
      setActionError({ error, context: "startProxy" });
    }
  };

  const handleEnableSystemProxy = () => {
    setActionError(null);
    enableSystemMutation.mutate(undefined, {
      onSuccess: () => goNext(),
      onError: (error) => setActionError({ error, context: "enableSystemProxy" }),
    });
  };

  const handleManualProxy = () => {
    acknowledgeManualProxy(startDefaults.port ?? DEFAULT_PROXY_PORT, startDefaults.workspaceId);
    goNext();
  };

  const handleOpenTestSite = () => {
    void openUrl(TEST_SITE_URL).catch(() => {
      // Opening the browser is best-effort; the step still guides the user.
    });
  };

  const handleFinish = () => {
    // Only mark the wizard completed when the user can actually capture HTTPS.
    // If not yet captureReady (e.g. SSL decryption still off), dismiss instead so
    // the persistent checklist keeps guiding them — never claim a false finish.
    if (progress.captureReady) {
      complete();
    } else {
      dismiss();
    }
    setOpen(false);
  };

  const handleClose = () => {
    dismiss();
    setOpen(false);
  };

  const handleRetry = () => {
    if (!actionError) {
      return;
    }
    const context = actionError.context;
    setActionError(null);
    if (context === "generate") handleGenerate();
    else if (context === "install") handleOpenInstaller();
    else if (context === "startProxy") handleStartProxy();
    else if (context === "enableSystemProxy") handleEnableSystemProxy();
  };

  const platform = certStatus?.platform ?? "macos";
  const stepIndex = STEP_ORDER.indexOf(activeStep);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { maxHeight: "85vh" } } }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pr: 1 }}>
        <Stack spacing={0.25}>
          <Typography variant="h6" component="span">
            {t("setupWizard.title")}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("setupWizard.subtitle")} · {stepIndex + 1}/{STEP_ORDER.length}
          </Typography>
        </Stack>
        <IconButton size="small" onClick={handleClose} aria-label={t("setupWizard.actions.skip")}>
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <LinearProgress
        variant="determinate"
        value={((stepIndex + 1) / STEP_ORDER.length) * 100}
        sx={{ height: 2 }}
      />

      <DialogContent sx={{ py: 2 }}>
        <Stack spacing={2}>
          <SetupWizardStepContent
            step={activeStep}
            certTrusted={certTrusted}
            certGenerated={!!certStatus?.certPath}
            proxyRunning={!!proxyStatus?.running}
            proxySatisfied={progress.proxySatisfied}
            hasFirstTraffic={hasFirstTraffic}
            platform={platform}
            verifyTrustStuck={verifyTrustStuck}
            generating={generateMutation.isPending}
            openingInstaller={installMutation.isPending}
            startingProxy={startProxyMutation.isPending}
            enablingSystem={enableSystemMutation.isPending}
            enablingSsl={stopProxyMutation.isPending || startProxyMutation.isPending}
            sslEnabled={!!proxyStatus?.sslEnabled}
            onGenerate={handleGenerate}
            onOpenInstaller={handleOpenInstaller}
            onInstalled={goNext}
            onStartProxy={handleStartProxy}
            onEnableSsl={handleEnableSsl}
            onEnableSystemProxy={handleEnableSystemProxy}
            onManualProxy={handleManualProxy}
            onOpenTestSite={handleOpenTestSite}
            onOpenGuide={() => navigate("/certificates?tab=desktop")}
            onNext={goNext}
            onBack={goBack}
            onFinish={handleFinish}
            onSetupMobile={() => {
              handleFinish();
              navigate("/certificates?tab=mobile");
            }}
          />

          {actionError && (
            <CertificateErrorGuidance
              error={actionError.error}
              context={actionError.context}
              onRetry={handleRetry}
            />
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
