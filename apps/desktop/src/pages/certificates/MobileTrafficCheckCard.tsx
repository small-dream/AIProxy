import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import { useEffect, useState } from "react";
import { Alert, AlertTitle, Button, CircularProgress, Stack, Typography } from "@mui/material";

import { computeMobileVerifyState } from "@/features/certificate-center/mobile-verify.helpers";
import { useSessions } from "@/features/sessions/use-sessions";
import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";

const VERIFY_TIMEOUT_MS = 120_000;
// Drives the timeout check; sessions themselves arrive live via
// use-session-events, but the clock needs a tick to notice the deadline.
const CLOCK_TICK_MS = 1_000;

type Baseline = {
  count: number;
  startedAtMs: number;
};

type Props = {
  proxyRunning: boolean;
};

/**
 * Closes the mobile setup loop: after installing the cert and pointing the
 * phone at the proxy, this card listens for the first NEW session so the user
 * gets a concrete "your phone's traffic is coming through" signal instead of
 * guessing from the session list.
 */
export function MobileTrafficCheckCard({ proxyRunning }: Props) {
  const { t, tList } = useI18n();
  const { data: sessions = [] } = useSessions();
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const state = computeMobileVerifyState({
    armed: baseline !== null,
    baselineCount: baseline?.count ?? 0,
    currentCount: sessions.length,
    baselineStartedAtMs: baseline?.startedAtMs ?? null,
    nowMs,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });

  // Tick the clock only while a run could still time out.
  useEffect(() => {
    if (state !== "listening") {
      return undefined;
    }
    const interval = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(interval);
  }, [state]);

  const handleStart = () => {
    setNowMs(Date.now());
    setBaseline({ count: sessions.length, startedAtMs: Date.now() });
  };

  const newSessionCount = baseline ? Math.max(0, sessions.length - baseline.count) : 0;

  return (
    <SectionCard
      compact
      title={t("certificatesPage.mobile.verify.title")}
      description={t("certificatesPage.mobile.verify.description")}
    >
      <Stack spacing={1.25}>
        {state === "idle" && (
          <>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {proxyRunning
                ? t("certificatesPage.mobile.verify.idleBody")
                : t("certificatesPage.mobile.verify.proxyNotRunningHint")}
            </Typography>
            <div>
              <Button
                size="small"
                variant="outlined"
                disabled={!proxyRunning}
                onClick={handleStart}
              >
                {t("certificatesPage.mobile.verify.start")}
              </Button>
            </div>
          </>
        )}

        {state === "listening" && (
          <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
            <CircularProgress size={18} sx={{ flexShrink: 0 }} />
            <Typography variant="body2">
              {t("certificatesPage.mobile.verify.listeningBody")}
            </Typography>
          </Stack>
        )}

        {state === "success" && (
          <Alert icon={<CheckCircleRoundedIcon fontSize="inherit" />} severity="success">
            <AlertTitle>{t("certificatesPage.mobile.verify.successTitle")}</AlertTitle>
            {t("certificatesPage.mobile.verify.successBody", { count: newSessionCount })}
          </Alert>
        )}

        {state === "timeout" && (
          <Alert severity="warning">
            <AlertTitle>{t("certificatesPage.mobile.verify.timeoutTitle")}</AlertTitle>
            <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.25 }}>
              {tList("certificatesPage.mobile.verify.timeoutTips").map((tip, index) => (
                <li key={index}>
                  <Typography variant="body2" component="span">
                    {tip}
                  </Typography>
                </li>
              ))}
            </Stack>
            <Button size="small" variant="outlined" sx={{ mt: 1 }} onClick={handleStart}>
              {t("certificatesPage.mobile.verify.retry")}
            </Button>
          </Alert>
        )}
      </Stack>
    </SectionCard>
  );
}
