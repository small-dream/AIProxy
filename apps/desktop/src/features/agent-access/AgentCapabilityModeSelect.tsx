import { MenuItem, Select } from "@mui/material";

import type { AgentCapability } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";

import type { AgentCapabilityMode } from "./agent-access.grant-policy";
import { permissionDefinition } from "./agent-access.permissions";

export function AgentCapabilityModeSelect({
  capability,
  disabled = false,
  mode,
  onChange,
}: {
  capability: AgentCapability;
  disabled?: boolean;
  mode: AgentCapabilityMode;
  onChange: (mode: AgentCapabilityMode) => void;
}) {
  const { t } = useI18n();
  const label = t("settingsPage.agentAccess.capabilityModeAria", {
    capability: t(permissionDefinition(capability).labelKey),
  });

  return (
    <Select
      size="small"
      value={mode}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as AgentCapabilityMode)}
      inputProps={{ "aria-label": label }}
      sx={{ minWidth: 112, "& .MuiSelect-select": { py: 0.75 } }}
    >
      <MenuItem value="deny">{t("settingsPage.agentAccess.capabilityModeDeny")}</MenuItem>
      <MenuItem value="ask">{t("settingsPage.agentAccess.capabilityModeAsk")}</MenuItem>
      <MenuItem value="always">{t("settingsPage.agentAccess.capabilityModeAlways")}</MenuItem>
    </Select>
  );
}
