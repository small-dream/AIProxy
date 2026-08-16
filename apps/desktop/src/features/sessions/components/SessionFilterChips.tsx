import CancelRoundedIcon from "@mui/icons-material/CancelRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import { Chip, Stack } from "@mui/material";

import { useI18n } from "@/i18n";

type SessionFilterChipsProps = {
  focusedHosts: ReadonlySet<string>;
  ignoredHosts: ReadonlySet<string>;
  showOnlyThrottled: boolean;
  onUnfocusHost: (host: string) => void;
  onStopIgnoringHost: (host: string) => void;
  onDisableThrottledOnly: () => void;
};

/**
 * One-line row of removable filter chips shown above the session list.
 * Focus/Ignore hide or reorder hosts inside the list, so their only reachable
 * "off" switch must live outside the filtered data — here. Renders nothing
 * when no filter is active so the list layout stays unchanged.
 */
export function SessionFilterChips({
  focusedHosts,
  ignoredHosts,
  showOnlyThrottled,
  onUnfocusHost,
  onStopIgnoringHost,
  onDisableThrottledOnly,
}: SessionFilterChipsProps) {
  const { t } = useI18n();

  if (focusedHosts.size === 0 && ignoredHosts.size === 0 && !showOnlyThrottled) {
    return null;
  }

  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{
        flex: "0 0 auto",
        flexWrap: "wrap",
        pb: 0.25,
        px: 1,
        pt: 0.75,
      }}
    >
      {[...focusedHosts].map((host) => (
        <Chip
          key={`focus-${host}`}
          color="primary"
          deleteIcon={
            <CancelRoundedIcon
              aria-label={t("sessionExplorer.unfocusHost", { host })}
              role="button"
            />
          }
          label={host}
          onDelete={() => onUnfocusHost(host)}
          size="small"
          variant="outlined"
        />
      ))}

      {[...ignoredHosts].map((host) => (
        <Chip
          key={`ignore-${host}`}
          deleteIcon={
            <CancelRoundedIcon
              aria-label={t("sessionExplorer.stopIgnoringHost", { host })}
              role="button"
            />
          }
          icon={<VisibilityOffRoundedIcon />}
          label={host}
          onDelete={() => onStopIgnoringHost(host)}
          size="small"
          variant="outlined"
        />
      ))}

      {showOnlyThrottled && (
        <Chip
          color="warning"
          deleteIcon={
            <CancelRoundedIcon aria-label={t("sessionExplorer.showAllSessions")} role="button" />
          }
          label={t("sessionsPage.filterThrottled")}
          onDelete={onDisableThrottledOnly}
          size="small"
          variant="outlined"
        />
      )}
    </Stack>
  );
}
