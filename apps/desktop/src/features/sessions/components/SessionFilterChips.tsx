import ArrowDropDownRoundedIcon from "@mui/icons-material/ArrowDropDownRounded";
import CancelRoundedIcon from "@mui/icons-material/CancelRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import { Chip, Divider, IconButton, Menu, MenuItem, Stack, Typography } from "@mui/material";
import { useState } from "react";

import { useI18n } from "@/i18n";

/** Beyond this many hosts in one category, chips collapse into a summary chip + popover. */
const MAX_INDIVIDUAL_HOST_CHIPS = 3;

type SessionFilterChipsProps = {
  focusedHosts: ReadonlySet<string>;
  ignoredHosts: ReadonlySet<string>;
  showOnlyThrottled: boolean;
  onUnfocusHost: (host: string) => void;
  onStopIgnoringHost: (host: string) => void;
  onDisableThrottledOnly: () => void;
};

type AggregatedHostsChipProps = {
  clearAllLabel: string;
  color?: "primary" | "default";
  hosts: string[];
  icon?: React.ReactElement;
  onRemoveHost: (host: string) => void;
  removeAriaLabel: (host: string) => string;
  summaryLabel: string;
};

/**
 * Summary chip for a category with many hosts: stays one chip in the row,
 * opens a popover listing every host (each individually removable) plus a
 * "clear all" entry. The menu stays open after a single removal so several
 * hosts can be cleared in one go.
 */
function AggregatedHostsChip({
  clearAllLabel,
  color,
  hosts,
  icon,
  onRemoveHost,
  removeAriaLabel,
  summaryLabel,
}: AggregatedHostsChipProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const closeMenu = () => setAnchorEl(null);

  return (
    <>
      <Chip
        color={color}
        deleteIcon={<ArrowDropDownRoundedIcon />}
        icon={icon}
        label={summaryLabel}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        onDelete={(event) => setAnchorEl(event.currentTarget as HTMLElement)}
        size="small"
        variant="outlined"
      />
      <Menu
        anchorEl={anchorEl}
        anchorOrigin={{ horizontal: "left", vertical: "bottom" }}
        onClose={closeMenu}
        open={anchorEl !== null}
        slotProps={{ list: { dense: true, sx: { py: 0.5 } } }}
      >
        {hosts.map((host) => (
          <MenuItem key={host} disableRipple sx={{ pr: 0.5 }}>
            <Typography noWrap sx={{ flex: 1, maxWidth: 320, minWidth: 0 }} variant="body2">
              {host}
            </Typography>
            <IconButton
              aria-label={removeAriaLabel(host)}
              onClick={() => onRemoveHost(host)}
              size="small"
            >
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </MenuItem>
        ))}
        <Divider sx={{ my: 0.5 }} />
        <MenuItem
          onClick={() => {
            hosts.forEach((host) => onRemoveHost(host));
            closeMenu();
          }}
        >
          <Typography color="text.secondary" variant="body2">
            {clearAllLabel}
          </Typography>
        </MenuItem>
      </Menu>
    </>
  );
}

/**
 * Single-line row of removable filter chips shown above the session list.
 * Focus/Ignore hide or reorder hosts inside the list, so their only reachable
 * "off" switch must live outside the filtered data — here. A category with
 * more than MAX_INDIVIDUAL_HOST_CHIPS hosts collapses into one summary chip
 * with a popover so the row never grows past one line. Renders nothing when
 * no filter is active so the list layout stays unchanged.
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

  const focusedHostList = [...focusedHosts];
  const ignoredHostList = [...ignoredHosts];

  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{
        flex: "0 0 auto",
        flexWrap: "nowrap",
        overflow: "hidden",
        pb: 0.25,
        px: 1,
        pt: 0.75,
        "& .MuiChip-root": { flex: "0 1 auto", minWidth: 0 },
        "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" },
      }}
    >
      {focusedHostList.length <= MAX_INDIVIDUAL_HOST_CHIPS ? (
        focusedHostList.map((host) => (
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
        ))
      ) : (
        <AggregatedHostsChip
          clearAllLabel={t("sessionExplorer.clearAllFocusedHosts")}
          color="primary"
          hosts={focusedHostList}
          onRemoveHost={onUnfocusHost}
          removeAriaLabel={(host) => t("sessionExplorer.unfocusHost", { host })}
          summaryLabel={t("sessionExplorer.focusedHostsSummary", {
            count: focusedHostList.length,
          })}
        />
      )}

      {ignoredHostList.length <= MAX_INDIVIDUAL_HOST_CHIPS ? (
        ignoredHostList.map((host) => (
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
        ))
      ) : (
        <AggregatedHostsChip
          clearAllLabel={t("sessionExplorer.clearAllIgnoredHosts")}
          hosts={ignoredHostList}
          icon={<VisibilityOffRoundedIcon />}
          onRemoveHost={onStopIgnoringHost}
          removeAriaLabel={(host) => t("sessionExplorer.stopIgnoringHost", { host })}
          summaryLabel={t("sessionExplorer.ignoredHostsSummary", {
            count: ignoredHostList.length,
          })}
        />
      )}

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
