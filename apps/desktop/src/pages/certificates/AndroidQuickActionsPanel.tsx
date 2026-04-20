import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useState } from "react";
import {
  Alert,
  AlertTitle,
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
  useAndroidAdbDevices,
  useClearAndroidProxyViaAdb,
  useInstallAndroidCertificateViaAdb,
  useSetAndroidProxyViaAdb,
} from "@/features/certificate-center/use-certificate-status";
import { useI18n } from "@/i18n";

type Props = {
  hasCert: boolean;
  localIp: string | null;
  proxyPort: number;
  proxyRunning: boolean;
};

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

export function AndroidQuickActionsPanel({
  hasCert,
  localIp,
  proxyPort,
  proxyRunning,
}: Props) {
  const { t } = useI18n();
  const [selectedAdbDeviceSerial, setSelectedAdbDeviceSerial] = useState("");
  const [showInfo, setShowInfo] = useState(false);

  const adbDevicesQuery = useAndroidAdbDevices();
  const adbInstallMutation = useInstallAndroidCertificateViaAdb();
  const adbSetProxyMutation = useSetAndroidProxyViaAdb();
  const adbClearProxyMutation = useClearAndroidProxyViaAdb();

  const adbDevices = adbDevicesQuery.data;
  const adbProxyAddress = localIp ? `${localIp}:${proxyPort}` : null;
  const isBusy =
    adbInstallMutation.isPending || adbSetProxyMutation.isPending || adbClearProxyMutation.isPending;

  const effectiveSelectedAdbDeviceSerial =
    selectedAdbDeviceSerial && adbDevices?.some((device) => device.serial === selectedAdbDeviceSerial)
      ? selectedAdbDeviceSerial
      : (adbDevices?.find((device) => device.state === "device") ?? adbDevices?.[0])?.serial ?? "";
  const selectedAdbDevice = adbDevices?.find((device) => device.serial === effectiveSelectedAdbDeviceSerial);

  const canInstallViaAdb =
    hasCert &&
    Boolean(selectedAdbDevice?.serial) &&
    selectedAdbDevice?.state === "device" &&
    !adbDevicesQuery.isLoading;
  const canManageProxyViaAdb =
    Boolean(selectedAdbDevice?.serial) &&
    selectedAdbDevice?.state === "device" &&
    !adbDevicesQuery.isLoading;
  const canSetProxyViaAdb = canManageProxyViaAdb && proxyRunning && Boolean(localIp);
  const proxySetupBlockedReason = !proxyRunning
    ? t("certificatesPage.mobile.adbProxyRequiresRunningProxy")
    : !localIp
      ? t("certificatesPage.mobile.adbProxyRequiresLocalIp")
      : null;

  function handleSetProxy() {
    if (!selectedAdbDevice?.serial || !localIp) return;
    adbInstallMutation.reset();
    adbClearProxyMutation.reset();
    adbSetProxyMutation.mutate({
      deviceSerial: selectedAdbDevice.serial,
      host: localIp,
      port: proxyPort,
    });
  }

  function handleClearProxy() {
    if (!selectedAdbDevice?.serial) return;
    adbInstallMutation.reset();
    adbSetProxyMutation.reset();
    adbClearProxyMutation.mutate({
      deviceSerial: selectedAdbDevice.serial,
    });
  }

  function handleInstallCertificate() {
    if (!selectedAdbDevice?.serial) return;
    adbSetProxyMutation.reset();
    adbClearProxyMutation.reset();
    adbInstallMutation.mutate({ deviceSerial: selectedAdbDevice.serial });
  }

  return (
    <SectionCard
      title={t("certificatesPage.mobile.quickActionsTitle")}
      toolbar={(
        <Tooltip arrow title={t("certificatesPage.mobile.quickActionsInfoAction")}>
          <IconButton
            aria-label={t("certificatesPage.mobile.quickActionsInfoAction")}
            onClick={() => setShowInfo((current) => !current)}
            size="small"
          >
            <InfoOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    >
      <Stack spacing={1.5}>
        {showInfo ? (
          <Alert severity="info">
            <AlertTitle>{t("certificatesPage.mobile.quickActionsInfoTitle")}</AlertTitle>
            <Stack spacing={0.5}>
              <Typography variant="body2">{t("certificatesPage.mobile.adbProxyBody")}</Typography>
              {adbProxyAddress ? (
                <Typography variant="body2">
                  {t("certificatesPage.mobile.adbProxyAddressHint", { proxyAddress: adbProxyAddress })}
                </Typography>
              ) : null}
              <Typography variant="body2">{t("certificatesPage.mobile.adbInstallBody")}</Typography>
              <Typography variant="body2">{t("certificatesPage.mobile.adbInstallRequirements")}</Typography>
              <Typography variant="body2">{t("certificatesPage.mobile.adbInstallHint")}</Typography>
            </Stack>
          </Alert>
        ) : null}

        {adbDevicesQuery.isError ? (
          <Alert severity="error">
            <AlertTitle>{t("certificatesPage.mobile.adbDeviceLoadErrorTitle")}</AlertTitle>
            {adbDevicesQuery.error.message}
          </Alert>
        ) : null}

        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ xs: "stretch", md: "center" }}>
          <FormControl
            size="small"
            disabled={adbDevicesQuery.isLoading || (adbDevices?.length ?? 0) === 0}
            sx={{
              flex: { xs: 1, md: "0 1 620px" },
              minWidth: { xs: "100%", md: 360 },
              maxWidth: { xs: "100%", md: 620 },
            }}
          >
            <InputLabel>{t("certificatesPage.mobile.adbDeviceSelectorLabel")}</InputLabel>
            <Select
              value={effectiveSelectedAdbDeviceSerial}
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
            size="small"
            onClick={() => adbDevicesQuery.refetch()}
            disabled={adbDevicesQuery.isFetching || isBusy}
          >
            {adbDevicesQuery.isFetching
              ? t("certificatesPage.mobile.adbRefreshingDevices")
              : t("certificatesPage.mobile.adbRefreshDevices")}
          </Button>
        </Stack>

        <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
          <Button
            variant="contained"
            size="small"
            onClick={handleSetProxy}
            disabled={!canSetProxyViaAdb || isBusy}
            startIcon={adbSetProxyMutation.isPending ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {adbSetProxyMutation.isPending
              ? t("certificatesPage.mobile.adbSettingProxy")
              : t("certificatesPage.mobile.adbSetProxyAction")}
          </Button>

          <Button
            variant="outlined"
            size="small"
            onClick={handleClearProxy}
            disabled={!canManageProxyViaAdb || isBusy}
            startIcon={adbClearProxyMutation.isPending ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {adbClearProxyMutation.isPending
              ? t("certificatesPage.mobile.adbClearingProxy")
              : t("certificatesPage.mobile.adbClearProxyAction")}
          </Button>

          <Button
            variant="outlined"
            size="small"
            onClick={handleInstallCertificate}
            disabled={!canInstallViaAdb || isBusy}
            startIcon={adbInstallMutation.isPending ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {adbInstallMutation.isPending
              ? t("certificatesPage.mobile.adbInstalling")
              : t("certificatesPage.mobile.adbInstallAction")}
          </Button>
        </Stack>

        {adbDevicesQuery.isLoading ? (
          <Typography variant="body2" color="text.secondary">
            {t("certificatesPage.mobile.adbLoadingDevices")}
          </Typography>
        ) : null}

        {!adbDevicesQuery.isLoading && !adbDevicesQuery.isError && (adbDevices?.length ?? 0) === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("certificatesPage.mobile.adbNoDevices")}
          </Typography>
        ) : null}

        {selectedAdbDevice && selectedAdbDevice.state !== "device" ? (
          <Alert severity="warning">
            {t("certificatesPage.mobile.adbDeviceStateHint", { state: selectedAdbDevice.state })}
          </Alert>
        ) : null}

        {!hasCert ? (
          <Typography variant="body2" color="text.secondary">
            {t("certificatesPage.mobile.adbInstallUnavailable")}
          </Typography>
        ) : null}

        {proxySetupBlockedReason ? (
          <Typography variant="body2" color="text.secondary">
            {proxySetupBlockedReason}
          </Typography>
        ) : null}

        {adbInstallMutation.isSuccess ? (
          <Alert severity="success">
            <AlertTitle>{t("certificatesPage.mobile.adbSuccessTitle")}</AlertTitle>
            {t("certificatesPage.mobile.adbSuccessBody", {
              deviceSerial: adbInstallMutation.data.deviceSerial,
              remotePath: adbInstallMutation.data.remotePath,
            })}
          </Alert>
        ) : null}

        {adbSetProxyMutation.isSuccess ? (
          <Alert severity="success">
            <AlertTitle>{t("certificatesPage.mobile.adbSetProxySuccessTitle")}</AlertTitle>
            {t("certificatesPage.mobile.adbSetProxySuccessBody", {
              deviceSerial: adbSetProxyMutation.data.deviceSerial,
              proxyAddress: adbSetProxyMutation.data.proxyAddress ?? adbProxyAddress ?? "",
            })}
          </Alert>
        ) : null}

        {adbClearProxyMutation.isSuccess ? (
          <Alert severity="success">
            <AlertTitle>{t("certificatesPage.mobile.adbClearProxySuccessTitle")}</AlertTitle>
            {t("certificatesPage.mobile.adbClearProxySuccessBody", {
              deviceSerial: adbClearProxyMutation.data.deviceSerial,
            })}
          </Alert>
        ) : null}

        {adbInstallMutation.isError ? (
          <Alert severity="error">
            <AlertTitle>{t("certificatesPage.mobile.adbErrorTitle")}</AlertTitle>
            {adbInstallMutation.error.message}
          </Alert>
        ) : null}

        {adbSetProxyMutation.isError ? (
          <Alert severity="error">
            <AlertTitle>{t("certificatesPage.mobile.adbSetProxyErrorTitle")}</AlertTitle>
            {adbSetProxyMutation.error.message}
          </Alert>
        ) : null}

        {adbClearProxyMutation.isError ? (
          <Alert severity="error">
            <AlertTitle>{t("certificatesPage.mobile.adbClearProxyErrorTitle")}</AlertTitle>
            {adbClearProxyMutation.error.message}
          </Alert>
        ) : null}
      </Stack>
    </SectionCard>
  );
}
