import { useEffect, useRef, useState } from "react";
import { Alert, AlertTitle, Box, Paper, Stack, Tab, Tabs, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  coerceAppError,
  DEFAULT_PROXY_PORT,
  type TrustRemovalFailure,
} from "@aiproxy/shared-types";

import {
  useCertificateStatus,
  useGenerateRootCertificate,
  useLaunchCertificateInstaller,
  useRemoveCertificateTrust,
} from "@/features/certificate-center/use-certificate-status";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useI18n, type TranslationKey } from "@/i18n";
import { useNotificationStore } from "@/services/notification.store";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { fontFamilies } from "@/themes/fonts";

import { CertificateRiskNotes } from "./CertificateRiskNotes";
import { DesktopCertificateTab } from "./DesktopCertificateTab";
import { PlatformTrustGuide } from "./PlatformTrustGuide";
import { MobileSetupTab } from "./MobileSetupTab";

type CertTab = "desktop" | "mobile";
type MobileQuickActionsPanel = "ios" | "android" | "harmony";

// Outcome of a completed (or failed) removal, rendered under the status card.
type RemoveFeedback =
  | { kind: "success" }
  | { kind: "partial"; failed: TrustRemovalFailure[]; systemProxyError?: string }
  | { kind: "error"; message: string };

// Manual removal commands for stores where the automated attempt is expected
// to fail without elevation (Windows LocalMachine, macOS system domain /
// System keychain, Linux system anchor dirs + CA store refresh). Store ids
// mirror `tls-manager::trust::trust_store`.
const MANUAL_COMMAND_KEYS: Record<string, TranslationKey> = {
  "windows.localMachineRoot": "certificatesPage.remove.manualCommands.windowsLocalMachine",
  "macos.systemDomain": "certificatesPage.remove.manualCommands.macosSystemDomain",
  "macos.loginKeychain": "certificatesPage.remove.manualCommands.macosLoginKeychain",
  "macos.systemKeychain": "certificatesPage.remove.manualCommands.macosSystemKeychain",
  "linux.anchors": "certificatesPage.remove.manualCommands.linuxAnchors",
  "linux.caStore": "certificatesPage.remove.manualCommands.linuxCaStore",
};

function RemoveFeedbackAlert({
  feedback,
  onDismiss,
}: {
  feedback: RemoveFeedback;
  onDismiss: () => void;
}) {
  const { t } = useI18n();

  if (feedback.kind === "error") {
    return (
      <Alert severity="error" onClose={onDismiss}>
        <AlertTitle>{t("certificatesPage.remove.errorTitle")}</AlertTitle>
        {feedback.message}
      </Alert>
    );
  }

  if (feedback.kind === "partial") {
    return (
      <Alert severity="warning" onClose={onDismiss}>
        <AlertTitle>{t("certificatesPage.remove.partialTitle")}</AlertTitle>
        {feedback.failed.length > 0 && (
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t("certificatesPage.remove.manualHint")}
          </Typography>
        )}
        {feedback.failed.map((failure) => {
          const commandKey = MANUAL_COMMAND_KEYS[failure.store];
          return (
            <Stack key={failure.store} spacing={0.25} sx={{ mb: 1 }}>
              <Typography variant="body2">
                {t("certificatesPage.remove.storeLabel", {
                  store: failure.store,
                  error: failure.error,
                })}
              </Typography>
              {commandKey && (
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                    fontFamily: fontFamilies.mono,
                    wordBreak: "break-all",
                  }}
                >
                  {t(commandKey)}
                </Typography>
              )}
            </Stack>
          );
        })}
        {feedback.systemProxyError && (
          <Typography variant="body2" sx={{ mt: feedback.failed.length > 0 ? 1 : 0 }}>
            {t("certificatesPage.remove.systemProxyErrorHint", {
              error: feedback.systemProxyError,
            })}
          </Typography>
        )}
      </Alert>
    );
  }

  return (
    <Alert severity="success" onClose={onDismiss}>
      <AlertTitle>{t("certificatesPage.remove.successTitle")}</AlertTitle>
      {t("certificatesPage.remove.successBody")}
    </Alert>
  );
}

export function CertificatesPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { data: status, isLoading, refetch } = useCertificateStatus();
  // P1-27: failures push a localized notification here; the meta opt-out
  // keeps the global MutationCache from raising the same failure twice.
  const generateMutation = useGenerateRootCertificate({
    meta: { suppressGlobalErrorNotification: true },
  });
  const installMutation = useLaunchCertificateInstaller({
    meta: { suppressGlobalErrorNotification: true },
  });
  const removeMutation = useRemoveCertificateTrust();
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removeFeedback, setRemoveFeedback] = useState<RemoveFeedback | null>(null);
  const { data: proxyStatus } = useProxyStatus();
  const [tab, setTab] = useState<CertTab>("desktop");
  const iosQuickActionsRef = useRef<HTMLDivElement | null>(null);
  const androidQuickActionsRef = useRef<HTMLDivElement | null>(null);
  const harmonyQuickActionsRef = useRef<HTMLDivElement | null>(null);

  const requestedTab = searchParams.get("tab");
  const requestedPanel = searchParams.get("panel");
  const initialTab = requestedTab === "desktop" || requestedTab === "mobile" ? requestedTab : null;
  const initialPanel: MobileQuickActionsPanel | null =
    requestedPanel === "ios" || requestedPanel === "android" || requestedPanel === "harmony"
      ? requestedPanel
      : null;

  useEffect(() => {
    if (initialTab) {
      setTab(initialTab);
    }
  }, [initialTab, location.key]);

  useEffect(() => {
    if (tab !== "mobile" || !initialPanel) {
      return;
    }

    const target =
      initialPanel === "ios"
        ? iosQuickActionsRef.current
        : initialPanel === "android"
          ? androidQuickActionsRef.current
          : harmonyQuickActionsRef.current;
    if (!target) {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [initialPanel, location.key, tab]);

  const handleGenerate = () => {
    setRemoveFeedback(null);
    generateMutation.mutate(
      { forceRegenerate: Boolean(status?.certPath) },
      {
        onSuccess: () => {
          refetch();
        },
        onError: (error) => {
          useNotificationStore
            .getState()
            .push(
              `${t("certificatesPage.actions.generateError")}: ${coerceAppError(error).message}`,
            );
        },
      },
    );
  };

  const handleInstall = () => {
    installMutation.mutate(undefined, {
      onError: (error) => {
        useNotificationStore
          .getState()
          .push(`${t("certificatesPage.actions.installError")}: ${coerceAppError(error).message}`);
      },
    });
  };

  const handleRefresh = () => {
    refetch();
  };

  const handleRequestRemove = () => {
    setRemoveFeedback(null);
    setRemoveConfirmOpen(true);
  };

  // Removal is confirmed in the dialog; the mutation revokes trust, deletes
  // the files and restarts the proxy HTTP-only (see remove_certificate_trust).
  // Either a per-store trust failure or a failed system-proxy hand-back makes
  // the result "partial" — the hand-back failure leaves the machine routed
  // through the now-untrusted proxy, so it must be surfaced, not logged away.
  const handleRemove = () => {
    removeMutation.mutate(undefined, {
      onSuccess: (output) => {
        setRemoveConfirmOpen(false);
        const hasIssues =
          output.trustRemoval.failed.length > 0 || !!output.systemProxyHandbackError;
        setRemoveFeedback(
          hasIssues
            ? {
                kind: "partial",
                failed: output.trustRemoval.failed,
                ...(output.systemProxyHandbackError
                  ? { systemProxyError: output.systemProxyHandbackError }
                  : {}),
              }
            : { kind: "success" },
        );
      },
      onError: (error) => {
        setRemoveConfirmOpen(false);
        setRemoveFeedback({ kind: "error", message: coerceAppError(error).message });
      },
    });
  };

  return (
    <Stack spacing={0.375} sx={{ height: "100%", minHeight: 0 }}>
      <Paper
        elevation={0}
        sx={(theme) => ({
          bgcolor: alpha(
            theme.palette.background.paper,
            theme.palette.mode === "dark" ? 0.94 : 0.98,
          ),
          border: "1px solid",
          borderColor: alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.78 : 0.92),
          borderRadius: 1.25,
          boxShadow:
            theme.palette.mode === "dark"
              ? "0 16px 44px rgba(0, 0, 0, 0.28)"
              : "0 16px 40px rgba(15, 23, 42, 0.08)",
          display: "flex",
          flex: 1,
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        })}
        variant="outlined"
      >
        <Box
          sx={{
            bgcolor: (theme) =>
              theme.palette.mode === "dark"
                ? alpha(theme.palette.background.default, 0.28)
                : alpha(theme.palette.background.default, 0.62),
            borderBottom: 1,
            borderColor: "divider",
            minWidth: 0,
          }}
        >
          <Tabs
            value={tab}
            onChange={(_, v: CertTab) => setTab(v)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{
              minHeight: 42,
              px: 0.75,
              py: 0.5,
              "& .MuiTabs-flexContainer": {
                gap: 0.5,
              },
              "& .MuiTabs-indicator": {
                display: "none",
              },
              "& .MuiTab-root": {
                border: "1px solid transparent",
                borderRadius: 1.25,
                color: "text.secondary",
                fontSize: 13,
                fontWeight: 500,
                height: 30,
                minHeight: 30,
                minWidth: 0,
                px: 1.1,
                py: 0,
                textTransform: "none",
                transition:
                  "background-color 140ms ease, border-color 140ms ease, color 140ms ease",
                "&:hover": {
                  bgcolor: (theme) =>
                    alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.08 : 0.05),
                  color: "text.primary",
                },
              },
              "& .Mui-selected": {
                bgcolor: (theme) =>
                  alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.18 : 0.1),
                borderColor: (theme) =>
                  alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.38 : 0.22),
                color: "text.primary",
                fontWeight: 600,
              },
            }}
          >
            <Tab label={t("certificatesPage.tabs.desktop")} value="desktop" />
            <Tab label={t("certificatesPage.tabs.mobile")} value="mobile" />
          </Tabs>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
          {tab === "desktop" && (
            <Stack spacing={1.5}>
              <DesktopCertificateTab
                status={status}
                loading={isLoading}
                generating={generateMutation.isPending}
                installing={installMutation.isPending}
                removing={removeMutation.isPending}
                onGenerate={handleGenerate}
                onInstall={handleInstall}
                onRefresh={handleRefresh}
                onRemove={handleRequestRemove}
              />
              {removeFeedback && (
                <RemoveFeedbackAlert
                  feedback={removeFeedback}
                  onDismiss={() => setRemoveFeedback(null)}
                />
              )}
              <PlatformTrustGuide currentPlatform={status?.platform ?? "windows"} />
              <CertificateRiskNotes />
            </Stack>
          )}

          {tab === "mobile" && (
            <MobileSetupTab
              androidQuickActionsRef={androidQuickActionsRef}
              harmonyQuickActionsRef={harmonyQuickActionsRef}
              proxyPort={proxyStatus?.port ?? DEFAULT_PROXY_PORT}
              proxyRunning={proxyStatus?.running ?? false}
              sslEnabled={proxyStatus?.sslEnabled ?? false}
              hasCert={!!status?.certPath}
              iosQuickActionsRef={iosQuickActionsRef}
            />
          )}
        </Box>
      </Paper>

      <ConfirmDialog
        open={removeConfirmOpen}
        title={t("certificatesPage.remove.confirmTitle")}
        message={t("certificatesPage.remove.confirmMessage")}
        confirmLabel={t("certificatesPage.remove.action")}
        isConfirming={removeMutation.isPending}
        onCancel={() => setRemoveConfirmOpen(false)}
        onConfirm={handleRemove}
      />
    </Stack>
  );
}
