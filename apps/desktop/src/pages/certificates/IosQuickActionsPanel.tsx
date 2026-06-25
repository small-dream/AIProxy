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
  useInstallIosCertificateViaSimulator,
  useIosSimulators,
} from "@/features/certificate-center/use-certificate-status";
import { useI18n } from "@/i18n";

type Props = {
  hasCert: boolean;
};

function formatSimulatorLabel(simulator: { name: string; runtime: string; state: string }) {
  return `${simulator.name} · ${simulator.runtime} · ${simulator.state}`;
}

export function IosQuickActionsPanel({ hasCert }: Props) {
  const { t, tList } = useI18n();
  const [selectedSimulatorUdid, setSelectedSimulatorUdid] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [showTrustSteps, setShowTrustSteps] = useState(false);

  // Silent auto-detection: scan on mount so booted iOS Simulators show up
  // without the user clicking anything. If Xcode simctl isn't installed (or
  // the probe fails for any reason — e.g. not on macOS) during this passive
  // scan, stay quiet — a red error on entry is noisy for users who simply
  // don't have Xcode. A *manual* refresh sets `userRefreshed`, after which
  // errors are shown: if the user explicitly asks to re-scan, they want to
  // know why it failed.
  const [userRefreshed, setUserRefreshed] = useState(false);

  const simulatorsQuery = useIosSimulators();

  function handleRefreshDevices() {
    setUserRefreshed(true);
    simulatorsQuery.refetch();
  }
  const installMutation = useInstallIosCertificateViaSimulator();

  const simulators = simulatorsQuery.data;
  const effectiveSelectedSimulatorUdid =
    selectedSimulatorUdid &&
    simulators?.some((simulator) => simulator.udid === selectedSimulatorUdid)
      ? selectedSimulatorUdid
      : (simulators?.[0]?.udid ?? "");
  const selectedSimulator = simulators?.find(
    (simulator) => simulator.udid === effectiveSelectedSimulatorUdid,
  );
  const canInstall =
    hasCert &&
    Boolean(selectedSimulator?.udid) &&
    !simulatorsQuery.isLoading &&
    !installMutation.isPending;

  function handleInstall() {
    if (!selectedSimulator?.udid) return;
    installMutation.mutate(
      {
        simulatorUdid: selectedSimulator.udid,
      },
      {
        onSuccess: () => {
          setShowTrustSteps(true);
        },
      },
    );
  }

  return (
    <SectionCard
      title={t("certificatesPage.mobile.iosQuickActionsTitle")}
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
            <AlertTitle>{t("certificatesPage.mobile.iosQuickActionsInfoTitle")}</AlertTitle>
            <Stack spacing={0.5}>
              <Typography variant="body2">
                {t("certificatesPage.mobile.iosSimulatorInstallBody")}
              </Typography>
              <Typography variant="body2">
                {t("certificatesPage.mobile.iosSimulatorInstallHint")}
              </Typography>
              <Typography variant="body2">
                {t("certificatesPage.mobile.iosDeviceManualHint")}
              </Typography>
            </Stack>
          </Alert>
        ) : null}

        {userRefreshed && simulatorsQuery.isError ? (
          <Alert severity="error">
            <AlertTitle>{t("certificatesPage.mobile.iosSimulatorLoadErrorTitle")}</AlertTitle>
            {simulatorsQuery.error.message}
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
            disabled={simulatorsQuery.isLoading || (simulators?.length ?? 0) === 0}
            sx={{
              flex: { xs: 1, md: "0 1 620px" },
              minWidth: { xs: "100%", md: 360 },
              maxWidth: { xs: "100%", md: 620 },
            }}
          >
            <InputLabel>{t("certificatesPage.mobile.iosSimulatorSelectorLabel")}</InputLabel>
            <Select
              value={effectiveSelectedSimulatorUdid}
              label={t("certificatesPage.mobile.iosSimulatorSelectorLabel")}
              onChange={(event) => setSelectedSimulatorUdid(event.target.value)}
              renderValue={(value) => {
                const simulator = simulators?.find((candidate) => candidate.udid === value);
                return simulator
                  ? formatSimulatorLabel(simulator)
                  : t("certificatesPage.mobile.iosSimulatorPlaceholder");
              }}
            >
              {(simulators ?? []).map((simulator) => (
                <MenuItem key={simulator.udid} value={simulator.udid}>
                  {formatSimulatorLabel(simulator)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button
            variant="outlined"
            size="small"
            onClick={handleRefreshDevices}
            disabled={simulatorsQuery.isFetching || installMutation.isPending}
          >
            {simulatorsQuery.isFetching
              ? t("certificatesPage.mobile.iosSimulatorRefreshing")
              : t("certificatesPage.mobile.iosSimulatorRefreshAction")}
          </Button>
        </Stack>

        <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
          <Button
            variant="contained"
            size="small"
            onClick={handleInstall}
            disabled={!canInstall}
            startIcon={
              installMutation.isPending ? <CircularProgress size={16} color="inherit" /> : undefined
            }
          >
            {installMutation.isPending
              ? t("certificatesPage.mobile.iosSimulatorInstalling")
              : t("certificatesPage.mobile.iosSimulatorInstallAction")}
          </Button>
        </Stack>

        {simulatorsQuery.isLoading ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("certificatesPage.mobile.iosSimulatorLoading")}
          </Typography>
        ) : null}

        {!simulatorsQuery.isLoading &&
        !simulatorsQuery.isError &&
        (simulators?.length ?? 0) === 0 ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("certificatesPage.mobile.iosSimulatorNoDevices")}
          </Typography>
        ) : null}

        {/* Silent probe failure (e.g. simctl unavailable / not on macOS): keep
            the panel quiet with a neutral prompt instead of a red error. A
            manual refresh surfaces the real error. */}
        {simulatorsQuery.isError && !userRefreshed ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("certificatesPage.mobile.iosSimulatorScanHint")}
          </Typography>
        ) : null}

        {!hasCert ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t("certificatesPage.mobile.iosSimulatorInstallUnavailable")}
          </Typography>
        ) : null}

        {installMutation.isSuccess ? (
          <Stack spacing={1}>
            <Alert severity="success">
              <AlertTitle>{t("certificatesPage.mobile.iosSimulatorSuccessTitle")}</AlertTitle>
              {t("certificatesPage.mobile.iosSimulatorSuccessBody", {
                simulatorName: installMutation.data.simulatorName,
              })}
            </Alert>

            <Alert
              severity="warning"
              action={
                <Button
                  color="inherit"
                  onClick={() => setShowTrustSteps((current) => !current)}
                  size="small"
                >
                  {showTrustSteps
                    ? t("certificatesPage.mobile.iosTrustStepsHideAction")
                    : t("certificatesPage.mobile.iosTrustStepsShowAction")}
                </Button>
              }
            >
              <AlertTitle>{t("certificatesPage.mobile.iosTrustStepsTitle")}</AlertTitle>
              <Stack spacing={0.75}>
                <Typography variant="body2">
                  {t("certificatesPage.mobile.iosTrustStepsBody")}
                </Typography>

                {showTrustSteps ? (
                  <Box
                    component="ol"
                    sx={{
                      m: 0,
                      pl: 3,
                      listStylePosition: "outside",
                      "& > li": {
                        mb: 0.75,
                      },
                      "& > li:last-child": {
                        mb: 0,
                      },
                    }}
                  >
                    {tList("certificatesPage.mobile.iosSimulatorTrustSteps").map((step, index) => (
                      <Typography component="li" key={index} variant="body2">
                        {step}
                      </Typography>
                    ))}
                  </Box>
                ) : null}
              </Stack>
            </Alert>
          </Stack>
        ) : null}

        {installMutation.isError ? (
          <Alert severity="error">
            <AlertTitle>{t("certificatesPage.mobile.iosSimulatorErrorTitle")}</AlertTitle>
            {installMutation.error.message}
          </Alert>
        ) : null}
      </Stack>
    </SectionCard>
  );
}
