import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";

import type { AdbProxyAction } from "@/components/layout/hooks/use-adb-actions";
import { formatAdbDeviceLabel } from "@/features/certificate-center/adb-devices.helpers";
import { useAndroidAdbDevices } from "@/features/certificate-center/use-certificate-status";
import { useI18n } from "@/i18n";

type Props = {
  open: boolean;
  /** Which quick-menu action the confirmed device will run; null while closed. */
  action: AdbProxyAction | null;
  /** Drives the confirm button's pending state while the action is running. */
  pending: boolean;
  onConfirm: (deviceSerial: string) => void;
  onCancel: () => void;
};

/**
 * Multi-device picker for the ADB quick-menu actions (set / clear proxy).
 * Single-device flows bypass this dialog and run immediately in
 * `useAdbActions`; this dialog appears only when several devices are present.
 */
export function AndroidAdbDevicePickerDialog({
  open,
  action,
  pending,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useI18n();
  const adbDevicesQuery = useAndroidAdbDevices({ enabled: open });
  const [selectedSerial, setSelectedSerial] = useState("");
  const [userRefreshed, setUserRefreshed] = useState(false);

  const adbDevices = adbDevicesQuery.data ?? [];

  // Reset the picker every time it reopens so a stale selection never carries
  // over to a different device list (e.g. after devices changed).
  useEffect(() => {
    if (!open) {
      setSelectedSerial("");
      setUserRefreshed(false);
    }
  }, [open]);

  function handleRefreshDevices() {
    setUserRefreshed(true);
    adbDevicesQuery.refetch();
  }

  const effectiveSelectedSerial = useMemo(() => {
    if (selectedSerial && adbDevices.some((device) => device.serial === selectedSerial)) {
      return selectedSerial;
    }
    return (
      adbDevices.find((device) => device.state === "device")?.serial ?? adbDevices[0]?.serial ?? ""
    );
  }, [selectedSerial, adbDevices]);
  const selectedDevice = adbDevices.find((device) => device.serial === effectiveSelectedSerial);

  // Only a ready ("device" state) target may be confirmed; when the fallback
  // selection lands on an offline/unauthorized device the confirm stays
  // disabled and a hint explains why (same rule as the quick-actions panel).
  const confirmDisabled =
    pending ||
    !effectiveSelectedSerial ||
    adbDevicesQuery.isLoading ||
    selectedDevice?.state !== "device";

  const title =
    action === "set"
      ? t("certificatesPage.mobile.adbDevicePickerTitleSet")
      : action === "clear"
        ? t("certificatesPage.mobile.adbDevicePickerTitleClear")
        : "";

  return (
    <Dialog fullWidth maxWidth="sm" onClose={pending ? undefined : onCancel} open={open}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          <FormControl size="small" disabled={adbDevicesQuery.isLoading || adbDevices.length === 0}>
            <InputLabel>{t("certificatesPage.mobile.adbDeviceSelectorLabel")}</InputLabel>
            <Select
              value={effectiveSelectedSerial}
              label={t("certificatesPage.mobile.adbDeviceSelectorLabel")}
              onChange={(event) => setSelectedSerial(event.target.value)}
              renderValue={(value) => {
                const device = adbDevices.find((candidate) => candidate.serial === value);
                return device
                  ? formatAdbDeviceLabel(device)
                  : t("certificatesPage.mobile.adbDevicePlaceholder");
              }}
            >
              {adbDevices.map((device) => (
                <MenuItem
                  key={device.serial}
                  value={device.serial}
                  disabled={device.state !== "device"}
                >
                  {formatAdbDeviceLabel(device)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {adbDevicesQuery.isLoading ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("certificatesPage.mobile.adbLoadingDevices")}
            </Typography>
          ) : null}

          {!adbDevicesQuery.isLoading && adbDevices.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("certificatesPage.mobile.adbNoDevices")}
            </Typography>
          ) : null}

          {selectedDevice && selectedDevice.state !== "device" ? (
            <Alert severity="warning">
              {t("certificatesPage.mobile.adbDeviceStateHint", { state: selectedDevice.state })}
            </Alert>
          ) : null}

          {adbDevicesQuery.isError && !userRefreshed ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("certificatesPage.mobile.adbScanHint")}
            </Typography>
          ) : null}

          {adbDevicesQuery.isError && userRefreshed ? (
            <Typography variant="body2" sx={{ color: "error.main" }}>
              {t("certificatesPage.mobile.adbDeviceLoadErrorTitle")}
            </Typography>
          ) : null}

          <Button
            variant="outlined"
            size="small"
            onClick={handleRefreshDevices}
            disabled={adbDevicesQuery.isFetching || pending}
            sx={{ alignSelf: "flex-start" }}
          >
            {adbDevicesQuery.isFetching
              ? t("certificatesPage.mobile.adbRefreshingDevices")
              : t("certificatesPage.mobile.adbRefreshDevices")}
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button disabled={pending} onClick={onCancel}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          color="primary"
          disabled={confirmDisabled}
          onClick={() => {
            if (effectiveSelectedSerial) {
              onConfirm(effectiveSelectedSerial);
            }
          }}
          startIcon={pending ? <CircularProgress size={16} color="inherit" /> : undefined}
          variant="contained"
        >
          {t("common.actions.confirm")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
