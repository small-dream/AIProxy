import { useEffect, useState } from "react";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import {
  useAndroidAdbDevices,
  useInstallAndroidCertificateViaAdb,
} from "@/features/certificate-center/use-certificate-status";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";

type Props = {
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

export function MobileDeviceGuide({ hasCert }: Props) {
  const { t, tList } = useI18n();
  const [activeTab, setActiveTab] = useState<MobileTab>("ios");
  const [selectedAdbDeviceSerial, setSelectedAdbDeviceSerial] = useState("");

  const adbDevicesQuery = useAndroidAdbDevices();
  const adbInstallMutation = useInstallAndroidCertificateViaAdb();

  const adbDevices = adbDevicesQuery.data;
  const selectedAdbDevice = adbDevices?.find((device) => device.serial === selectedAdbDeviceSerial);

  useEffect(() => {
    if (activeTab !== "android") return;
    if (selectedAdbDeviceSerial && adbDevices?.some((device) => device.serial === selectedAdbDeviceSerial)) return;
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
    <SectionCard title={t("certificatesPage.mobile.setupGuide")} description={t("certificatesPage.mobile.sectionDescription")}>
      <Stack spacing={2}>
        <Tabs
          value={activeTab}
          onChange={(_, v: MobileTab) => setActiveTab(v)}
          sx={{ borderBottom: 1, borderColor: "divider" }}
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
              <Stack spacing={0.5}>
                <Typography variant="body2">{t("certificatesPage.mobile.adbInstallBody")}</Typography>
                <Typography variant="body2">{t("certificatesPage.mobile.adbInstallRequirements")}</Typography>
                <Typography variant="body2">{t("certificatesPage.mobile.adbSelectedDeviceHint")}</Typography>
                <Typography variant="body2">{t("certificatesPage.mobile.adbInstallHint")}</Typography>
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
                size="small"
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
                size="small"
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
    </SectionCard>
  );
}
