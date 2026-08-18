import { useEffect, useState } from "react";
import { TextField } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";

import { useI18n } from "@/i18n";

type PriorityFieldProps = {
  value: number;
  onCommit: (priority: number) => void;
  /** Localized label, e.g. formatRuleFieldLabel(t("rulesPage.editor.priority"), "optional", t). */
  label: string;
  /** Show the localized precedence hint below the field. Defaults to true. */
  showHint?: boolean;
  size?: "small" | "medium";
  sx?: SxProps<Theme>;
};

// Shared priority input for every rule editor (rewrite/map/dns/script/throttle).
// Previously this exact "local text draft + onBlur commit" logic was copied
// verbatim into five panels; keep one copy here. Callers pass the localized
// label (the throttle page uses its own label) while the precedence hint is
// read from the shared rulesPage.priorityHint key.
export function PriorityField(props: PriorityFieldProps) {
  const { t } = useI18n();
  // L3: priority is committed from a local text draft so clearing the field
  // doesn't instantly snap to 0 mid-edit (the old `Number(value) || 0`).
  const [priorityText, setPriorityText] = useState(String(props.value));
  useEffect(() => {
    if (props.value !== Number(priorityText)) {
      setPriorityText(String(props.value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  return (
    <TextField
      size={props.size ?? "small"}
      type="number"
      label={props.label}
      value={priorityText}
      helperText={props.showHint === false ? undefined : t("rulesPage.priorityHint")}
      onChange={(e) => {
        setPriorityText(e.target.value);
        const parsed = Number(e.target.value);
        if (Number.isFinite(parsed) && e.target.value.trim() !== "") {
          props.onCommit(parsed);
        }
      }}
      onBlur={() => {
        const parsed = Number(priorityText);
        const next = Number.isFinite(parsed) && priorityText.trim() !== "" ? parsed : 0;
        setPriorityText(String(next));
        if (props.value !== next) props.onCommit(next);
      }}
      sx={props.sx}
    />
  );
}
