import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import PlayCircleRoundedIcon from "@mui/icons-material/PlayCircleRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import { Button, Paper, Stack, Typography } from "@mui/material";
import { useNavigate } from "react-router-dom";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { type SetupStepKey } from "@/features/certificate-center/setup-progress.helpers";
import { useSetupWizard } from "@/features/setup-wizard/use-setup-wizard";
import { useI18n, type TranslationKey } from "@/i18n";

const STEP_LABEL_KEYS: Record<SetupStepKey, TranslationKey> = {
  certGenerated: "setupChecklist.steps.certGenerated",
  certTrusted: "setupChecklist.steps.certTrusted",
  proxyRunning: "setupChecklist.steps.proxyRunning",
  sslDecryption: "setupChecklist.steps.sslDecryption",
  systemProxyOrManual: "setupChecklist.steps.systemProxyOrManual",
};

const STEP_ORDER: readonly SetupStepKey[] = [
  "certGenerated",
  "certTrusted",
  "proxyRunning",
  "sslDecryption",
  "systemProxyOrManual",
];

// Persistent setup guide shown on the Sessions page whenever the user cannot yet
// capture HTTPS traffic (!captureReady), regardless of wizard dismiss/complete
// state. It is the recovery path for skipped or regressed setups. The wizard
// remains the first-run strong guide; this card is the honest, always-on reminder.
export function SetupChecklistCard() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { progress, shouldShowChecklist } = useSetupWizard();
  const resetSetupWizardState = useAppPreferencesStore((s) => s.resetSetupWizardState);

  if (!shouldShowChecklist) {
    return null;
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack spacing={0.25}>
          <Typography variant="subtitle1" fontWeight={600}>
            {t("setupChecklist.title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("setupChecklist.subtitle")}
          </Typography>
        </Stack>

        <Stack spacing={0.5}>
          {STEP_ORDER.map((step) => {
            const done = progress.steps[step];
            const current = progress.nextAction === step;
            const Icon = done
              ? CheckCircleRoundedIcon
              : current
                ? PlayCircleRoundedIcon
                : RadioButtonUncheckedRoundedIcon;
            const color = done ? "success.main" : current ? "primary.main" : "text.disabled";

            return (
              <Stack key={step} direction="row" spacing={1} alignItems="center">
                <Icon sx={{ fontSize: 20, color }} />
                <Typography
                  variant="body2"
                  color={done ? "text.secondary" : "text.primary"}
                  sx={{ textDecoration: done ? "line-through" : "none" }}
                >
                  {t(STEP_LABEL_KEYS[step])}
                </Typography>
              </Stack>
            );
          })}
        </Stack>

        <Stack direction="row" spacing={1}>
          <Button
            variant="contained"
            size="small"
            onClick={() => navigate("/certificates?tab=desktop")}
          >
            {t("setupChecklist.openCertificates")}
          </Button>
          <Button variant="text" size="small" color="inherit" onClick={resetSetupWizardState}>
            {t("setupChecklist.openWizard")}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
