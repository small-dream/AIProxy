import TimerOutlinedIcon from "@mui/icons-material/TimerOutlined";
import { Chip, Tooltip } from "@mui/material";
import { useEffect, useState } from "react";

import {
  formatCountdown,
  isExpiringSoon,
  remainingMs,
} from "@/features/breakpoints/breakpoint-timer.helpers";
import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

/**
 * Live countdown until the backend auto-forwards the pending hit unchanged
 * (BREAKPOINT_WAIT_TIMEOUT, 5 min). Best-effort display driven by the
 * frontend-stamped receivedAt; the authoritative release signal is the
 * `breakpoint-released` event, which removes the hit — and this chip with it.
 */
export function BreakpointCountdownChip({ receivedAt }: { receivedAt: number }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const ms = remainingMs(receivedAt, now);

  return (
    <Tooltip title={t("breakpointPanel.countdownTooltip")}>
      <Chip
        color={isExpiringSoon(ms) ? "warning" : "default"}
        icon={<TimerOutlinedIcon />}
        label={formatCountdown(ms)}
        size="small"
        sx={{ fontFamily: fontFamilies.mono, fontSize: 11, height: 20 }}
        variant="outlined"
      />
    </Tooltip>
  );
}
