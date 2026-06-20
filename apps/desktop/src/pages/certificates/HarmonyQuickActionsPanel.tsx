import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useState } from "react";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";

import { SectionCard } from "@/components/shared/SectionCard";
import {
  useHarmonyHdcDevices,
  useInstallHarmonyCertificateViaHdc,
} from "@/features/certificate-center/use-certificate-status";
import { useI18n } from "@/i18n";

type Props = {
  hasCert: boolean;
  localIp: string | null;
  proxyPort: number;
  proxyRunning: boolean;
};

function formatHdcDeviceLabel(device: { serial: string; state: string; model?: string }) {
  const primaryLabel = device.model ?? device.serial;
  return `${primaryLabel} (${device.serial}) - ${device.state}`;
}

export function HarmonyQuickActionsPanel({
  hasCert,
  localIp,
  proxyPort,
  proxyRunning,
}: Props) {
  const { t, tList } = useI18n();
  const [selectedDeviceSerial, setSelectedDeviceSerial] = useState("");
  const [showInfo, setShowInfo] = useState(false);

  // Device scan is opt-in: most users (e.g. web-only capture) don't have
  // hdc installed, so probing on mount would surface a red error immediately.
  // Scan only when the user explicitly refreshes.
  const [hdcQueryTriggered, setHdcQueryTriggered] = useState(false);

  const hdcDevicesQuery = useHarmonyHdcDevices({ enabled: hdcQueryTriggered });

  function ensureHdcDevicesLoaded() {
    if (!hdcQueryTriggered) {
      setHdcQueryTriggered(true);
      return;
    }
    hdcDevicesQuery.refetch();
  }
  const hdcInstallMutation = useInstallHarmonyCertificateViaHdc();

  const hdcDevices = hdcDevicesQuery.data;
  const proxyAddress = localIp ? `${localIp}:${proxyPort}` : null;

  const effectiveSelectedDeviceSerial =
    selectedDeviceSerial &&
    hdcDevices?.some((device) => device.serial === selectedDeviceSerial)
      ? selectedDeviceSerial
      : ((hdcDevices?.find((device) => device.state === "Connected") ?? hdcDevices?.[0])?.serial ??
        "");
  const selectedDevice = hdcDevices?.find(
    (device) => device.serial === effectiveSelectedDeviceSerial,
  );

  const canInstallViaHdc =
    hasCert &&
    Boolean(selectedDevice?.serial) &&
    selectedDevice?.state === "Connected" &&
    !hdcDevicesQuery.isLoading;

  return (
    <SectionCard
      title={t("certificatesPage.mobile.harmonyQuickActionsTitle")}
      toolbar={
        <Tooltip arrow title={t("certificatesPage.mobile.quickActionsInfoAction")}>
          <IconButton
            aria-label={t("certificatesPage.mobile.quickActionsInfoAction")}
            onClick={() => setShowInfo((current) => !current)}
            size="small"
          >
            <InfoOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      }
    >
      <Stack spacing={1.5}>
        {showInfo ? (
          <Alert severity="info">
            <AlertTitle>{t("certificatesPage.mobile.hdcQuickActionsInfoTitle")}</AlertTitle>
            <Stack spacing={0.5}>
              <Typography variant="body2">{t("certificatesPage.mobile.hdcInstallBody")}</Typography>
              <Typography variant="body2">
                {t("certificatesPage.mobile.hdcInstallRequirements")}
              </Typography>
              <Typography variant="body2">{t("certificatesPage.mobile.hdcInstallHint")}</Typography>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 500,
                  mt: 0.5
                }}>
                {t("certificatesPage.mobile.hdcManualProxyTitle")}
              </Typography>
              <Typography variant="body2">
                {t("certificatesPage.mobile.hdcManualProxyBody")}
              </Typography>
              {proxyAddress ? (
                <Typography variant="body2">
                  {t("certificatesPage.mobile.hdcProxyAddressHint", {
                    proxyAddress,
                  })}
                </Typography>
              ) : null}
            </Stack>
          </Alert>
        ) : null}

        {!proxyRunning ? (
          <Alert severity="info">
            <AlertTitle>{t("certificatesPage.mobile.proxyNotRunningTitle")}</AlertTitle>
            {t("certificatesPage.mobile.proxyNotRunningBody")}
          </Alert>
        ) : null}

        {hdcQueryTriggered && hdcDevicesQuery.isError ? (
          <Alert severity="error">
            <AlertTitle>{t("certificatesPage.mobile.hdcDeviceLoadErrorTitle")}</AlertTitle>
            {hdcDevicesQuery.error.message}
          </Alert>
        ) : null}

        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          sx={{
            alignItems: { xs: "stretch", md: "center" }
          }}
        >
          <FormControl
            size="small"
            disabled={hdcDevicesQuery.isLoading || (hdcDevices?.length ?? 0) === 0}
            sx={{
              flex: { xs: 1, md: "0 1 620px" },
              minWidth: { xs: "100%", md: 360 },
              maxWidth: { xs: "100%", md: 620 },
            }}
          >
            <InputLabel>{t("certificatesPage.mobile.hdcDeviceSelectorLabel")}</InputLabel>
            <Select
              value={effectiveSelectedDeviceSerial}
              label={t("certificatesPage.mobile.hdcDeviceSelectorLabel")}
              onChange={(event) => setSelectedDeviceSerial(event.target.value)}
              renderValue={(value) => {
                const device = hdcDevices?.find((candidate) => candidate.serial === value);
                return device
                  ? formatHdcDeviceLabel(device)
                  : t("certificatesPage.mobile.hdcDevicePlaceholder");
              }}
            >
              {(hdcDevices ?? []).map((device) => (
                <MenuItem key={device.serial} value={device.serial}>
                  {formatHdcDeviceLabel(device)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button
            variant="outlined"
            size="small"
            onClick={ensureHdcDevicesLoaded}
            disabled={hdcDevicesQuery.isFetching || hdcInstallMutation.isPending}
          >
            {hdcDevicesQuery.isFetching
              ? t("certificatesPage.mobile.hdcRefreshingDevices")
              : t("certificatesPage.mobile.hdcRefreshDevices")}
          </Button>
        </Stack>

        <Button
          variant="contained"
          size="small"
          onClick={() => {
            if (!selectedDevice?.serial) return;
            hdcInstallMutation.reset();
            hdcInstallMutation.mutate({ deviceSerial: selectedDevice.serial });
          }}
          disabled={!canInstallViaHdc || hdcInstallMutation.isPending}
          startIcon={
            hdcInstallMutation.isPending ? (
              <CircularProgress size={16} color="inherit" />
            ) : undefined
          }
          sx={{ alignSelf: "flex-start" }}
        >
          {hdcInstallMutation.isPending
            ? t("certificatesPage.mobile.hdcInstalling")
            : t("certificatesPage.mobile.hdcInstallAction")}
        </Button>

        {!hdcQueryTriggered ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("certificatesPage.mobile.hdcScanHint")}
          </Typography>
        ) : null}

        {hdcQueryTriggered && hdcDevicesQuery.isLoading ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("certificatesPage.mobile.hdcLoadingDevices")}
          </Typography>
        ) : null}

        {hdcQueryTriggered &&
        !hdcDevicesQuery.isLoading &&
        !hdcDevicesQuery.isError &&
        (hdcDevices?.length ?? 0) === 0 ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("certificatesPage.mobile.hdcNoDevices")}
          </Typography>
        ) : null}

        {selectedDevice && selectedDevice.state !== "Connected" ? (
          <Alert severity="warning">
            {t("certificatesPage.mobile.hdcDeviceStateHint", { state: selectedDevice.state })}
          </Alert>
        ) : null}

        {!hasCert ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("certificatesPage.mobile.hdcInstallUnavailable")}
          </Typography>
        ) : null}

        {hdcInstallMutation.isSuccess ? (
          <Box>
            <Alert severity="success">
              <AlertTitle>{t("certificatesPage.mobile.hdcSuccessTitle")}</AlertTitle>
              {t("certificatesPage.mobile.hdcSuccessBody", {
                deviceSerial: hdcInstallMutation.data.deviceSerial,
                remotePath: hdcInstallMutation.data.remotePath,
              })}
            </Alert>
            <Box
              component="ol"
              sx={{
                pl: 2.5,
                mt: 1,
                mb: 0,
                "& li": { fontSize: 13, mb: 0.5 },
              }}
            >
              {tList("certificatesPage.mobile.hdcManualInstallSteps").map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </Box>
          </Box>
        ) : null}

        {hdcInstallMutation.isError ? (
          <Alert severity="error">
            <AlertTitle>{t("certificatesPage.mobile.hdcErrorTitle")}</AlertTitle>
            {hdcInstallMutation.error.message}
          </Alert>
        ) : null}
      </Stack>
    </SectionCard>
  );
}
