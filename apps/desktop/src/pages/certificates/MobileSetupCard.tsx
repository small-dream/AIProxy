import { useState } from "react";
import { Alert, AlertTitle, Box, Button, Chip, Divider, Stack, Tab, Tabs, Typography } from "@mui/material";
import { QRCodeSVG } from "qrcode.react";
import { SectionCard } from "@/components/shared/SectionCard";
import { useLocalIp } from "@/features/certificate-center/use-mobile-setup";
import { iosSteps, androidSteps } from "./mobile-guides";

type Props = {
  proxyPort: number;
  proxyRunning: boolean;
  sslEnabled: boolean;
  hasCert: boolean;
};

type MobileTab = "ios" | "android";

export function MobileSetupCard({ proxyPort, proxyRunning, sslEnabled, hasCert }: Props) {
  const { data: localIps, isLoading: ipsLoading } = useLocalIp();
  const [activeTab, setActiveTab] = useState<MobileTab>("ios");

  const localIp = localIps?.[0];
  const certDownloadUrl = localIp && proxyRunning ? `http://${localIp}:${proxyPort}/pharles-ca.crt` : null;
  const proxyAddress = localIp ? `${localIp}:${proxyPort}` : null;

  const guideSteps = activeTab === "ios" ? iosSteps : androidSteps;

  return (
    <SectionCard title="Mobile Capture Setup" description="Configure your phone to capture traffic through Pharles.">
      <Stack spacing={3}>
        {/* Prerequisites check */}
        {!proxyRunning && (
          <Alert severity="warning">
            <AlertTitle>Proxy Not Running</AlertTitle>
            Start the proxy first, then configure your phone to connect to it.
          </Alert>
        )}

        {proxyRunning && !sslEnabled && (
          <Alert severity="info">
            <AlertTitle>HTTP Only</AlertTitle>
            SSL is disabled. Only plain HTTP traffic will be captured. Enable SSL to capture HTTPS traffic.
          </Alert>
        )}

        {/* Network info */}
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">Network Information</Typography>

          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>Local IP:</Typography>
            {ipsLoading ? (
              <Chip label="Detecting..." size="small" />
            ) : localIp ? (
              <Typography variant="body2" sx={{ fontFamily: "monospace", fontWeight: 600 }}>{localIp}</Typography>
            ) : (
              <Chip label="Not detected" color="error" size="small" />
            )}
          </Stack>

          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>Proxy Port:</Typography>
            <Typography variant="body2" sx={{ fontFamily: "monospace", fontWeight: 600 }}>{proxyPort}</Typography>
          </Stack>

          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 120 }}>Wi-Fi Proxy:</Typography>
            {proxyAddress ? (
              <Typography variant="body2" sx={{ fontFamily: "monospace", fontWeight: 600, color: "primary.main" }}>
                {proxyAddress}
              </Typography>
            ) : (
              <Chip label="N/A" size="small" />
            )}
          </Stack>
        </Stack>

        {/* QR Code for cert download */}
        {sslEnabled && hasCert && certDownloadUrl && (
          <>
            <Divider />
            <Stack spacing={1.5}>
              <Typography variant="subtitle2">Download Certificate</Typography>
              <Typography variant="body2" color="text.secondary">
                Scan the QR code on your phone to download the root CA certificate, then follow the guide below to install it.
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
            Start the proxy to generate the certificate download QR code.
          </Typography>
        )}

        {!sslEnabled && proxyAddress && (
          <>
            <Divider />
            <Stack spacing={1.5}>
              <Typography variant="subtitle2">Proxy Configuration</Typography>
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
          <Typography variant="subtitle2">Setup Guide</Typography>

          <Tabs
            value={activeTab}
            onChange={(_, v: MobileTab) => setActiveTab(v)}
            sx={{ borderBottom: 1, borderColor: "divider", mb: 1 }}
          >
            <Tab label="iOS" value="ios" />
            <Tab label="Android" value="android" />
          </Tabs>

          <Box component="ol" sx={{ pl: 2, m: 0 }}>
            {guideSteps.map((step) => (
              <li key={step.order}>
                <Typography variant="body2" sx={{ mb: 1 }}>{step.description}</Typography>
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
              Copy Proxy Address
            </Button>
          </>
        )}
      </Stack>
    </SectionCard>
  );
}
