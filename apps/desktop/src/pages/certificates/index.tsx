import { useEffect, useRef, useState } from "react";
import { Box, Paper, Stack, Tab, Tabs } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useLocation, useSearchParams } from "react-router-dom";

import {
  useCertificateStatus,
  useGenerateRootCertificate,
  useLaunchCertificateInstaller,
} from "@/features/certificate-center/use-certificate-status";
import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useI18n } from "@/i18n";

import { DesktopCertificateTab } from "./DesktopCertificateTab";
import { PlatformTrustGuide } from "./PlatformTrustGuide";
import { MobileSetupTab } from "./MobileSetupTab";

type CertTab = "desktop" | "mobile";
type MobileQuickActionsPanel = "ios" | "android" | "harmony";

export function CertificatesPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { data: status, isLoading, refetch } = useCertificateStatus();
  const generateMutation = useGenerateRootCertificate();
  const installMutation = useLaunchCertificateInstaller();
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
    generateMutation.mutate(
      { forceRegenerate: Boolean(status?.certPath) },
      {
        onSuccess: () => {
          refetch();
        },
      },
    );
  };

  const handleInstall = () => {
    installMutation.mutate();
  };

  const handleRefresh = () => {
    refetch();
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
                onGenerate={handleGenerate}
                onInstall={handleInstall}
                onRefresh={handleRefresh}
              />
              <PlatformTrustGuide currentPlatform={status?.platform ?? "windows"} />
            </Stack>
          )}

          {tab === "mobile" && (
            <MobileSetupTab
              androidQuickActionsRef={androidQuickActionsRef}
              harmonyQuickActionsRef={harmonyQuickActionsRef}
              proxyPort={proxyStatus?.port ?? 8888}
              proxyRunning={proxyStatus?.running ?? false}
              sslEnabled={proxyStatus?.sslEnabled ?? false}
              hasCert={!!status?.certPath}
              iosQuickActionsRef={iosQuickActionsRef}
            />
          )}
        </Box>
      </Paper>
    </Stack>
  );
}
