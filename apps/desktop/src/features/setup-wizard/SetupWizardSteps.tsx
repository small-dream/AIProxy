import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import { Alert, AlertTitle, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";

import { useI18n, type TranslationKey } from "@/i18n";

export type WizardStep =
  | "welcome"
  | "generate"
  | "install"
  | "verifyTrust"
  | "startProxy"
  | "sslDecryption"
  | "routing"
  | "verifyTraffic"
  | "complete";

type Platform = "windows" | "macos" | "linux";

type Props = {
  step: WizardStep;
  certTrusted: boolean;
  certGenerated: boolean;
  proxyRunning: boolean;
  proxySatisfied: boolean;
  sslEnabled: boolean;
  hasFirstTraffic: boolean;
  platform: Platform;
  verifyTrustStuck: boolean;
  generating: boolean;
  openingInstaller: boolean;
  startingProxy: boolean;
  enablingSystem: boolean;
  enablingSsl: boolean;
  onGenerate: () => void;
  onOpenInstaller: () => void;
  onInstalled: () => void;
  onStartProxy: () => void;
  onEnableSsl: () => void;
  onEnableSystemProxy: () => void;
  onManualProxy: () => void;
  onOpenTestSite: () => void;
  onOpenGuide: () => void;
  onNext: () => void;
  onBack: () => void;
  onFinish: () => void;
  onSetupMobile: () => void;
};

const PLATFORM_HINT_KEYS: Record<Platform, TranslationKey> = {
  macos: "setupWizard.install.macosHint",
  windows: "setupWizard.install.windowsHint",
  linux: "setupWizard.install.linuxHint",
};

function StepHeader({ title, body }: { title: string; body?: string }) {
  return (
    <Stack spacing={0.75}>
      <Typography variant="h6">{title}</Typography>
      {body && (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {body}
        </Typography>
      )}
    </Stack>
  );
}

function SuccessBanner({ children }: { children: React.ReactNode }) {
  return (
    <Alert severity="success" icon={<CheckCircleRoundedIcon fontSize="inherit" />}>
      {children}
    </Alert>
  );
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ justifyContent: "space-between", alignItems: "center" }}
    >
      {children}
    </Stack>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="text" color="inherit" onClick={onClick}>
      {label}
    </Button>
  );
}

export function SetupWizardStepContent(props: Props) {
  const { t, tList } = useI18n();
  const {
    step,
    certTrusted,
    certGenerated,
    proxyRunning,
    proxySatisfied,
    sslEnabled,
    hasFirstTraffic,
    platform,
    verifyTrustStuck,
    generating,
    openingInstaller,
    startingProxy,
    enablingSystem,
    enablingSsl,
    onGenerate,
    onOpenInstaller,
    onInstalled,
    onStartProxy,
    onEnableSsl,
    onEnableSystemProxy,
    onManualProxy,
    onOpenTestSite,
    onOpenGuide,
    onNext,
    onBack,
    onFinish,
    onSetupMobile,
  } = props;

  switch (step) {
    case "welcome":
      return (
        <Stack spacing={2}>
          <StepHeader title={t("setupWizard.welcome.title")} body={t("setupWizard.welcome.body")} />
          <Alert severity="info">{t("setupWizard.welcome.privacyNote")}</Alert>
          <ActionRow>
            <span />
            <Button variant="contained" onClick={onNext}>
              {t("setupWizard.actions.next")}
            </Button>
          </ActionRow>
        </Stack>
      );

    case "generate":
      return (
        <Stack spacing={2}>
          <StepHeader
            title={t("setupWizard.generate.title")}
            body={t("setupWizard.generate.body")}
          />
          {certGenerated ? (
            <SuccessBanner>{t("setupWizard.generate.success")}</SuccessBanner>
          ) : null}
          <ActionRow>
            <BackButton label={t("setupWizard.actions.back")} onClick={onBack} />
            {certGenerated ? (
              <Button variant="contained" onClick={onNext}>
                {t("setupWizard.actions.next")}
              </Button>
            ) : (
              <Button
                variant="contained"
                onClick={onGenerate}
                disabled={generating}
                startIcon={generating ? <CircularProgress size={16} color="inherit" /> : undefined}
              >
                {generating
                  ? t("setupWizard.generate.generating")
                  : t("setupWizard.generate.action")}
              </Button>
            )}
          </ActionRow>
        </Stack>
      );

    case "install":
      return (
        <Stack spacing={2}>
          <StepHeader title={t("setupWizard.install.title")} body={t("setupWizard.install.body")} />
          <Alert severity="info">{t(PLATFORM_HINT_KEYS[platform])}</Alert>
          <ActionRow>
            <BackButton label={t("setupWizard.actions.back")} onClick={onBack} />
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                onClick={onOpenInstaller}
                disabled={openingInstaller}
                startIcon={
                  openingInstaller ? <CircularProgress size={16} color="inherit" /> : undefined
                }
              >
                {openingInstaller
                  ? t("setupWizard.install.opening")
                  : t("setupWizard.install.action")}
              </Button>
              <Button variant="contained" onClick={onInstalled}>
                {t("setupWizard.install.installed")}
              </Button>
            </Stack>
          </ActionRow>
        </Stack>
      );

    case "verifyTrust":
      return (
        <Stack spacing={2}>
          <StepHeader title={t("setupWizard.verify.title")} />
          {certTrusted ? (
            <SuccessBanner>{t("setupWizard.verify.success")}</SuccessBanner>
          ) : (
            <Alert severity="info" icon={<CircularProgress size={18} color="inherit" />}>
              {t("setupWizard.verify.waiting")}
            </Alert>
          )}
          {!certTrusted && verifyTrustStuck && (
            <Alert severity="warning">
              <AlertTitle>{t("setupWizard.verify.stuckTitle")}</AlertTitle>
              {t("setupWizard.verify.stuckBody")}
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{
                  flexWrap: "wrap",
                  mt: 1,
                }}
              >
                <Button size="small" variant="outlined" color="inherit" onClick={onBack}>
                  {t("setupWizard.verify.backToInstall")}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={onOpenInstaller}
                  disabled={openingInstaller}
                >
                  {t("setupWizard.verify.reopenInstaller")}
                </Button>
                <Button size="small" variant="text" color="inherit" onClick={onOpenGuide}>
                  {t("setupWizard.verify.openCertificates")}
                </Button>
              </Stack>
            </Alert>
          )}
          {/* Always offer a way back so the user isn't trapped waiting. */}
          {!certTrusted && !verifyTrustStuck && (
            <ActionRow>
              <BackButton label={t("setupWizard.actions.back")} onClick={onBack} />
              <span />
            </ActionRow>
          )}
        </Stack>
      );

    case "startProxy":
      return (
        <Stack spacing={2}>
          <StepHeader
            title={t("setupWizard.startProxy.title")}
            body={t("setupWizard.startProxy.body")}
          />
          {proxyRunning ? (
            <SuccessBanner>{t("setupWizard.startProxy.running")}</SuccessBanner>
          ) : null}
          <ActionRow>
            <BackButton label={t("setupWizard.actions.back")} onClick={onBack} />
            {proxyRunning ? (
              <Button variant="contained" onClick={onNext}>
                {t("setupWizard.actions.next")}
              </Button>
            ) : (
              <Button
                variant="contained"
                onClick={onStartProxy}
                disabled={startingProxy}
                startIcon={
                  startingProxy ? <CircularProgress size={16} color="inherit" /> : undefined
                }
              >
                {startingProxy
                  ? t("setupWizard.startProxy.starting")
                  : t("setupWizard.startProxy.action")}
              </Button>
            )}
          </ActionRow>
        </Stack>
      );

    case "sslDecryption":
      return (
        <Stack spacing={2}>
          <StepHeader
            title={t("setupWizard.sslDecryption.title")}
            body={t("setupWizard.sslDecryption.body")}
          />
          {sslEnabled ? (
            <SuccessBanner>{t("setupWizard.sslDecryption.on")}</SuccessBanner>
          ) : (
            <Alert severity="warning">
              <AlertTitle>{t("setupWizard.sslDecryption.offTitle")}</AlertTitle>
              {t("setupWizard.sslDecryption.offBody")}
            </Alert>
          )}
          <ActionRow>
            <BackButton label={t("setupWizard.actions.back")} onClick={onBack} />
            {sslEnabled ? (
              <Button variant="contained" onClick={onNext}>
                {t("setupWizard.actions.next")}
              </Button>
            ) : (
              // No "Next" while SSL is off: the user must enable it to proceed
              // (or go back / skip via the title-bar close). Avoids a silent
              // downgrade to dismiss at the finish step.
              <Button
                variant="contained"
                onClick={onEnableSsl}
                disabled={enablingSsl}
                startIcon={enablingSsl ? <CircularProgress size={16} color="inherit" /> : undefined}
              >
                {enablingSsl
                  ? t("setupWizard.sslDecryption.enabling")
                  : t("setupWizard.sslDecryption.action")}
              </Button>
            )}
          </ActionRow>
        </Stack>
      );

    case "routing":
      return (
        <Stack spacing={2}>
          <StepHeader title={t("setupWizard.routing.title")} body={t("setupWizard.routing.body")} />
          {proxySatisfied ? (
            <SuccessBanner>{t("setupWizard.routing.systemOn")}</SuccessBanner>
          ) : null}
          <ActionRow>
            <BackButton label={t("setupWizard.actions.back")} onClick={onBack} />
            {proxySatisfied ? (
              <Button variant="contained" onClick={onNext}>
                {t("setupWizard.actions.next")}
              </Button>
            ) : (
              <Stack direction="row" spacing={1}>
                <Button variant="text" color="inherit" onClick={onManualProxy}>
                  {t("setupWizard.routing.manual")}
                </Button>
                <Button
                  variant="contained"
                  onClick={onEnableSystemProxy}
                  disabled={enablingSystem}
                  startIcon={
                    enablingSystem ? <CircularProgress size={16} color="inherit" /> : undefined
                  }
                >
                  {enablingSystem
                    ? t("setupWizard.routing.enabling")
                    : t("setupWizard.routing.enableSystem")}
                </Button>
              </Stack>
            )}
          </ActionRow>
        </Stack>
      );

    case "verifyTraffic":
      return (
        <Stack spacing={2}>
          <StepHeader
            title={t("setupWizard.verifyTraffic.title")}
            body={t("setupWizard.verifyTraffic.body")}
          />
          {hasFirstTraffic ? (
            <SuccessBanner>{t("setupWizard.verifyTraffic.success")}</SuccessBanner>
          ) : (
            <Stack spacing={1.5}>
              <Alert severity="info" icon={<CircularProgress size={18} color="inherit" />}>
                {t("setupWizard.verifyTraffic.waiting")}
              </Alert>
              <Alert severity="warning">
                <AlertTitle>{t("setupWizard.verifyTraffic.triageTitle")}</AlertTitle>
                <Box component="ul" sx={{ m: 0, pl: 2.25 }}>
                  {tList("setupWizard.verifyTraffic.triageItems").map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </Box>
              </Alert>
            </Stack>
          )}
          <ActionRow>
            <BackButton label={t("setupWizard.actions.back")} onClick={onBack} />
            <Stack direction="row" spacing={1}>
              {!hasFirstTraffic && (
                <Button variant="outlined" onClick={onOpenTestSite}>
                  {t("setupWizard.verifyTraffic.openTestSite")}
                </Button>
              )}
              <Button variant="contained" onClick={onNext}>
                {t("setupWizard.actions.finish")}
              </Button>
            </Stack>
          </ActionRow>
        </Stack>
      );

    case "complete":
      return (
        <Stack spacing={2}>
          <StepHeader
            title={t("setupWizard.complete.title")}
            body={t("setupWizard.complete.body")}
          />
          <Alert severity="info">
            {t("setupWizard.complete.mobileInvite")}
            <Box sx={{ mt: 1 }}>
              <Button size="small" variant="outlined" onClick={onSetupMobile}>
                {t("setupWizard.complete.mobileAction")}
              </Button>
            </Box>
          </Alert>
          <ActionRow>
            <span />
            <Button variant="contained" onClick={onFinish}>
              {t("setupWizard.actions.finish")}
            </Button>
          </ActionRow>
        </Stack>
      );

    default:
      return null;
  }
}
