import { useState } from "react";
import { Alert, AlertTitle, Box, Button, Chip, Divider, Stack, Tab, Tabs, Typography } from "@mui/material";
import { QRCodeSVG } from "qrcode.react";
import { SectionCard } from "@/components/shared/SectionCard";
import { useLocalIp } from "@/features/certificate-center/use-mobile-setup";
import { useI18n } from "@/i18n";

type Props = {
  proxyPort: number;
  proxyRunning: boolean;
  sslEnabled: boolean;
  hasCert: boolean;
};

type MobileTab = "ios" | "android";

export function MobileSetupCard({ proxyPort, proxyRunning, sslEnabled, hasCert }: Props) {
  const { t, tList } = useI18n();
  const { data: localIps, isLoading: ipsLoading } = useLocalIp();
  const [activeTab, setActiveTab] = useState<MobileTab>("ios");

  const localIp = localIps?.[0];
  const certDownloadUrl = localIp && proxyRunning ? `http://${localIp}:${proxyPort}/pharles-ca.crt` : null;
  const proxyAddress = localIp ? `${localIp}:${proxyPort}` : null;

  const guideSteps =
    activeTab === "ios"
      ? tList("certificatesPage.mobile.iosSteps")
      : tList("certificatesPage.mobile.androidSteps");

  return (
    <SectionCard title={t("certificatesPage.mobile.sectionTitle")} description={t("certificatesPage.mobile.sectionDescription")}>
      <Stack spacing={3}>
        {/* Prerequisites check */}
        {!proxyRunning && (
          <Alert severity="warning">
            <AlertTitle>{t("certificatesPage.mobile.proxyNotRunningTitle")}</AlertTitle>
            {t("certificatesPage.mobile.proxyNotRunningBody")}
          </Alert>
        )}

        {proxyRunning && !sslEnabled && (
          <Alert severity="info">
            <AlertTitle>{t("certificatesPage.mobile.httpOnlyTitle")}</AlertTitle>
            {t("certificatesPage.mobile.httpOnlyBody")}
          </Alert>
        )}

        {/* Network info */}
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">{t("certificatesPage.mobile.networkInfo")}</Typography>

          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>{t("certificatesPage.mobile.localIp")}</Typography>
            {ipsLoading ? (
              <Chip label={t("common.states.detecting")} size="small" />
            ) : localIp ? (
              <Typography variant="body2" sx={{ fontFamily: "monospace", fontWeight: 600 }}>{localIp}</Typography>
            ) : (
              <Chip label={t("common.states.notDetected")} color="error" size="small" />
            )}
          </Stack>

          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>{t("certificatesPage.mobile.proxyPort")}</Typography>
            <Typography variant="body2" sx={{ fontFamily: "monospace", fontWeight: 600 }}>{proxyPort}</Typography>
          </Stack>

          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>{t("certificatesPage.mobile.wifiProxy")}</Typography>
            {proxyAddress ? (
              <Typography variant="body2" sx={{ fontFamily: "monospace", fontWeight: 600, color: "primary.main" }}>
                {proxyAddress}
              </Typography>
            ) : (
              <Chip label={t("common.states.na")} size="small" />
            )}
          </Stack>
        </Stack>

        {/* QR Code for cert download */}
        {sslEnabled && hasCert && certDownloadUrl && (
          <>
            <Divider />
            <Stack spacing={1.5}>
              <Typography variant="subtitle2">{t("certificatesPage.mobile.downloadCertificate")}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t("certificatesPage.mobile.certQrHint")}
              </Typography>

              <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
                <Box sx={{ p: 2, bgcolor: "white", borderRadius: 1, display: "inline-block" }}>
                  <QRCodeSVG value={certDownloadUrl} size={180} />
                </Box>
              </Box>

              <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center", fontFamily: "monospace", wordBreak: "break-all" }}>
                {certDownloadUrl}
              </Typography>
            </Stack>
          </>
        )}

        {/* QR Code for proxy info (when SSL is off) */}
        {sslEnabled && hasCert && !certDownloadUrl && (
          <Typography variant="body2" color="text.secondary">
            {t("certificatesPage.mobile.noCertQr")}
          </Typography>
        )}

        {!sslEnabled && proxyAddress && (
          <>
            <Divider />
            <Stack spacing={1.5}>
              <Typography variant="subtitle2">{t("certificatesPage.mobile.proxyConfiguration")}</Typography>
              <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
                <Box sx={{ p: 2, bgcolor: "white", borderRadius: 1, display: "inline-block" }}>
                  <QRCodeSVG value={`proxy:${proxyAddress}`} size={180} />
                </Box>
              </Box>
            </Stack>
          </>
        )}

        {/* Setup guides */}
        <Divider />
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">{t("certificatesPage.mobile.setupGuide")}</Typography>

          <Tabs
            value={activeTab}
            onChange={(_, v: MobileTab) => setActiveTab(v)}
            sx={{ borderBottom: 1, borderColor: "divider", mb: 1 }}
          >
            <Tab label={t("certificatesPage.mobile.ios")} value="ios" />
            <Tab label={t("certificatesPage.mobile.android")} value="android" />
          </Tabs>

          <Box component="ol" sx={{ pl: 2, m: 0 }}>
            {guideSteps.map((step, index) => (
              <li key={`${activeTab}-${index}`}>
                <Typography variant="body2" sx={{ mb: 1 }}>{step}</Typography>
              </li>
            ))}
          </Box>
        </Stack>

        {/* Copy proxy address */}
        {proxyAddress && (
          <>
            <Divider />
            <Button
              variant="outlined"
              size="small"
              onClick={() => navigator.clipboard.writeText(proxyAddress)}
            >
              {t("certificatesPage.mobile.copyProxyAddress")}
            </Button>
          </>
        )}
      </Stack>
    </SectionCard>
  );
}
