import { useEffect, useState } from "react";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import { QRCodeSVG } from "qrcode.react";
import { SectionCard } from "@/components/shared/SectionCard";
import {
  useAndroidAdbDevices,
  useInstallAndroidCertificateViaAdb,
} from "@/features/certificate-center/use-certificate-status";
import { useLocalIp } from "@/features/certificate-center/use-mobile-setup";
import { useI18n } from "@/i18n";

type Props = {
  proxyPort: number;
  proxyRunning: boolean;
  sslEnabled: boolean;
  hasCert: boolean;
};

type MobileTab = "ios" | "android";

function formatAdbDeviceLabel(device: {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
}) {
  const primaryLabel = device.model ?? device.product ?? device.device ?? device.serial;
  return `${primaryLabel} (${device.serial}) - ${device.state}`;
}

export function MobileSetupCard({ proxyPort, proxyRunning, sslEnabled, hasCert }: Props) {
  const { t, tList } = useI18n();
  const { data: localIps, isLoading: ipsLoading } = useLocalIp();
  const adbDevicesQuery = useAndroidAdbDevices();
  const adbInstallMutation = useInstallAndroidCertificateViaAdb();
  const [activeTab, setActiveTab] = useState<MobileTab>("ios");
  const [selectedAdbDeviceSerial, setSelectedAdbDeviceSerial] = useState("");

  const localIp = localIps?.[0];
  const certDownloadUrl = localIp && proxyRunning ? `http://${localIp}:${proxyPort}/pharles-ca.crt` : null;
  const proxyAddress = localIp ? `${localIp}:${proxyPort}` : null;
  const adbDevices = adbDevicesQuery.data;
  const selectedAdbDevice = adbDevices?.find((device) => device.serial === selectedAdbDeviceSerial);

  useEffect(() => {
    if (activeTab !== "android") {
      return;
    }

    if (selectedAdbDeviceSerial && adbDevices?.some((device) => device.serial === selectedAdbDeviceSerial)) {
      return;
    }

    const nextDevice = adbDevices?.find((device) => device.state === "device") ?? adbDevices?.[0];
    setSelectedAdbDeviceSerial(nextDevice?.serial ?? "");
  }, [activeTab, adbDevices, selectedAdbDeviceSerial]);

  const guideSteps =
    activeTab === "ios"
      ? tList("certificatesPage.mobile.iosSteps")
      : tList("certificatesPage.mobile.androidSteps");

  const canInstallViaAdb =
    hasCert &&
    Boolean(selectedAdbDevice?.serial) &&
    selectedAdbDevice?.state === "device" &&
    !adbDevicesQuery.isLoading;

  return (
    <SectionCard title={t("certificatesPage.mobile.sectionTitle")} description={t("certificatesPage.mobile.sectionDescription")}>
      <Stack spacing={3}>
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

          {activeTab === "android" && (
            <Stack spacing={1.5}>
              <Alert severity="info">
                <AlertTitle>{t("certificatesPage.mobile.adbInstallTitle")}</AlertTitle>
                <Stack spacing={1}>
                  <Typography variant="body2">
                    {t("certificatesPage.mobile.adbInstallBody")}
                  </Typography>
                  <Typography variant="body2">
                    {t("certificatesPage.mobile.adbInstallRequirements")}
                  </Typography>
                  <Typography variant="body2">
                    {t("certificatesPage.mobile.adbSelectedDeviceHint")}
                  </Typography>
                  <Typography variant="body2">
                    {t("certificatesPage.mobile.adbInstallHint")}
                  </Typography>
                </Stack>
              </Alert>

              {adbDevicesQuery.isError && (
                <Alert severity="error">
                  <AlertTitle>{t("certificatesPage.mobile.adbDeviceLoadErrorTitle")}</AlertTitle>
                  {adbDevicesQuery.error.message}
                </Alert>
              )}

              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ xs: "stretch", sm: "center" }}>
                <FormControl size="small" fullWidth disabled={adbDevicesQuery.isLoading || (adbDevices?.length ?? 0) === 0}>
                  <InputLabel>{t("certificatesPage.mobile.adbDeviceSelectorLabel")}</InputLabel>
                  <Select
                    value={selectedAdbDeviceSerial}
                    label={t("certificatesPage.mobile.adbDeviceSelectorLabel")}
                    onChange={(event) => setSelectedAdbDeviceSerial(event.target.value)}
                    renderValue={(value) => {
                      const device = adbDevices?.find((candidate) => candidate.serial === value);
                      return device ? formatAdbDeviceLabel(device) : t("certificatesPage.mobile.adbDevicePlaceholder");
                    }}
                  >
                    {(adbDevices ?? []).map((device) => (
                      <MenuItem key={device.serial} value={device.serial}>
                        {formatAdbDeviceLabel(device)}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                <Button
                  variant="outlined"
                  onClick={() => adbDevicesQuery.refetch()}
                  disabled={adbDevicesQuery.isFetching}
                >
                  {adbDevicesQuery.isFetching
                    ? t("certificatesPage.mobile.adbRefreshingDevices")
                    : t("certificatesPage.mobile.adbRefreshDevices")}
                </Button>
              </Stack>

              {adbDevicesQuery.isLoading && (
                <Typography variant="body2" color="text.secondary">
                  {t("certificatesPage.mobile.adbLoadingDevices")}
                </Typography>
              )}

              {!adbDevicesQuery.isLoading && !adbDevicesQuery.isError && (adbDevices?.length ?? 0) === 0 && (
                <Typography variant="body2" color="text.secondary">
                  {t("certificatesPage.mobile.adbNoDevices")}
                </Typography>
              )}

              {selectedAdbDevice && selectedAdbDevice.state !== "device" && (
                <Alert severity="warning">
                  {t("certificatesPage.mobile.adbDeviceStateHint", { state: selectedAdbDevice.state })}
                </Alert>
              )}

              <Box>
                <Button
                  variant="contained"
                  onClick={() => adbInstallMutation.mutate(selectedAdbDevice?.serial ? { deviceSerial: selectedAdbDevice.serial } : undefined)}
                  disabled={!canInstallViaAdb || adbInstallMutation.isPending}
                  startIcon={adbInstallMutation.isPending ? <CircularProgress size={16} color="inherit" /> : undefined}
                >
                  {adbInstallMutation.isPending
                    ? t("certificatesPage.mobile.adbInstalling")
                    : t("certificatesPage.mobile.adbInstallAction")}
                </Button>
              </Box>

              {!hasCert && (
                <Typography variant="body2" color="text.secondary">
                  {t("certificatesPage.mobile.adbInstallUnavailable")}
                </Typography>
              )}

              {adbInstallMutation.isSuccess && (
                <Alert severity="success">
                  <AlertTitle>{t("certificatesPage.mobile.adbSuccessTitle")}</AlertTitle>
                  {t("certificatesPage.mobile.adbSuccessBody", {
                    deviceSerial: adbInstallMutation.data.deviceSerial,
                    remotePath: adbInstallMutation.data.remotePath,
                  })}
                </Alert>
              )}

              {adbInstallMutation.isError && (
                <Alert severity="error">
                  <AlertTitle>{t("certificatesPage.mobile.adbErrorTitle")}</AlertTitle>
                  {adbInstallMutation.error.message}
                </Alert>
              )}
            </Stack>
          )}
        </Stack>

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
