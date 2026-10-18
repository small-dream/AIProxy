import { useId } from "react";
import { MenuItem, Select, Typography } from "@mui/material";
import Stack from "@mui/material/Stack";
import type { MatchType } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";

const MATCH_TYPES: MatchType[] = ["contains", "wildcard", "exact", "regex"];

/**
 * Shared match-type picker used by the map / DNS / script / rewrite / breakpoint
 * editors. The caption is wired to the Select through `aria-labelledby` so the
 * control is reachable by its label; the keys are shared with
 * `rulesPage.editor.matchType*` (R6).
 */
export function MatchTypeSelect(props: {
  hint?: boolean;
  onChange: (value: MatchType) => void;
  size?: "small" | "medium";
  value: MatchType | undefined;
}) {
  const { t } = useI18n();
  const { hint = true, onChange, size = "small", value } = props;
  const current = value ?? "contains";
  // Stable per-instance id: two editors can be mounted at once, so a hardcoded
  // label id would duplicate.
  const labelId = useId();

  return (
    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
      <Typography
        variant="caption"
        id={labelId}
        sx={{
          color: "text.secondary",
          fontWeight: 650,
        }}
      >
        {t("rulesPage.editor.matchType")}
      </Typography>
      <Select
        size={size}
        labelId={labelId}
        value={current}
        onChange={(e) => onChange(e.target.value as MatchType)}
      >
        {MATCH_TYPES.map((type) => (
          <MenuItem key={type} value={type}>
            {t(`rulesPage.editor.matchTypes.${type}`)}
          </MenuItem>
        ))}
      </Select>
      {hint && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            lineHeight: 1.35,
          }}
        >
          {t(`rulesPage.editor.matchTypes.${current}Hint`)}
        </Typography>
      )}
    </Stack>
  );
}
