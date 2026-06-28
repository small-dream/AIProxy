import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import FilterAltRoundedIcon from "@mui/icons-material/FilterAltRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import {
  Alert,
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";

import { useEffect, useState } from "react";

import type { ThrottleProfile, ThrottleRule } from "@aiproxy/shared-types";

import type { TranslationKey, TranslationParams } from "@/i18n";
import { EditorHeader } from "./EditorHeader";

export function RuleEditor(props: {
  draft: ThrottleRule | null;
  errors: string[];
  isError?: boolean;
  profiles: ThrottleProfile[];
  t: (key: TranslationKey, params?: TranslationParams) => string;
  onChange: (patch: Partial<ThrottleRule>) => void;
  onDuplicate: (rule: ThrottleRule) => void;
  onDelete: (ruleId: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { draft, errors, isError = false, profiles, t, onChange, onDuplicate, onDelete, onSave, saving } = props;

  // L3: priority is committed from a local text draft so clearing the field
  // doesn't instantly snap to 0 mid-edit (the old `Number(value) || 0`). Mirrors
  // ProfileEditor. Declared before the early return so hooks are unconditional.
  const draftPriority = draft?.priority ?? 0;
  const [priorityText, setPriorityText] = useState(String(draftPriority));
  useEffect(() => {
    if (draftPriority !== Number(priorityText)) {
      setPriorityText(String(draftPriority));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftPriority]);

  if (!draft) {
    return <EmptyHint>{t("throttlingPage.rulesSelectHint")}</EmptyHint>;
  }

  return (
    <Stack spacing={1.5}>
      <EditorHeader
        icon={<FilterAltRoundedIcon />}
        title={draft.name}
        subtitle={t("throttlingPage.rulesDescription")}
      />
      {errors.length > 0 ? (
        <Alert severity="warning" variant="outlined">
          {errors.join(" ")}
        </Alert>
      ) : null}
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", md: "1.2fr 0.8fr" } }}>
        <TextField
          size="small"
          label={t("throttlingPage.ruleFields.name")}
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <FormControl size="small">
          <InputLabel>{t("throttlingPage.ruleFields.profile")}</InputLabel>
          <Select
            label={t("throttlingPage.ruleFields.profile")}
            value={draft.profileId}
            onChange={(event) => onChange({ profileId: event.target.value })}
          >
            {profiles.map((profile) => (
              <MenuItem key={profile.id} value={profile.id}>
                {profile.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <TextField
          size="small"
          label={t("throttlingPage.ruleFields.urlPattern")}
          value={draft.urlPattern}
          onChange={(event) => onChange({ urlPattern: event.target.value })}
        />
        <TextField
          size="small"
          label={t("throttlingPage.ruleFields.methods")}
          placeholder="GET, POST, PUT"
          value={draft.methods.join(", ")}
          onChange={(event) =>
            onChange({
              methods: event.target.value
                .split(",")
                .map((value) => value.trim().toUpperCase())
                .filter(Boolean),
            })
          }
        />
        <FormControl size="small">
          <InputLabel>{t("throttlingPage.ruleFields.stage")}</InputLabel>
          <Select
            label={t("throttlingPage.ruleFields.stage")}
            value={draft.stage}
            onChange={(event) => onChange({ stage: event.target.value as ThrottleRule["stage"] })}
          >
            <MenuItem value="both">{t("throttlingPage.stageBoth")}</MenuItem>
            <MenuItem value="request">{t("throttlingPage.stageRequest")}</MenuItem>
            <MenuItem value="response">{t("throttlingPage.stageResponse")}</MenuItem>
          </Select>
        </FormControl>
        <TextField
          size="small"
          label={t("throttlingPage.ruleFields.priority")}
          type="number"
          value={priorityText}
          onChange={(event) => {
            setPriorityText(event.target.value);
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed) && event.target.value.trim() !== "") {
              onChange({ priority: parsed });
            }
          }}
          onBlur={() => {
            const parsed = Number(priorityText);
            const next = Number.isFinite(parsed) && priorityText.trim() !== "" ? parsed : 0;
            setPriorityText(String(next));
            if (draft.priority !== next) onChange({ priority: next });
          }}
        />
      </Box>
      <Stack
        direction="row"
        spacing={0.75}
        sx={{
          alignItems: "center",
          border: 1,
          borderColor: "divider",
          borderRadius: "8px",
          px: 1.25,
          py: 0.75
        }}>
        <Switch
          size="small"
          checked={draft.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
        <Typography variant="body2" sx={{ fontWeight: 650 }}>
          {t("throttlingPage.ruleFields.enabled")}
        </Typography>
        <Typography variant="caption" sx={{
          color: "text.secondary"
        }}>
          {t("throttlingPage.ruleFields.enabledHint")}
        </Typography>
      </Stack>
      <Stack direction="row" spacing={1} sx={{
        justifyContent: "space-between"
      }}>
        <Button
          color="error"
          variant="outlined"
          disabled={isError}
          startIcon={<DeleteOutlineRoundedIcon />}
          onClick={() => onDelete(draft.id)}
        >
          {t("throttlingPage.deleteRule")}
        </Button>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            disabled={isError}
            startIcon={<ReplayRoundedIcon />}
            onClick={() => onDuplicate(draft)}
          >
            {t("throttlingPage.duplicateRule")}
          </Button>
          <Button variant="contained" onClick={onSave} disabled={saving}>
            {t("throttlingPage.saveRule")}
          </Button>
        </Stack>
      </Stack>
    </Stack>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="body2"
      sx={{
        color: "text.secondary",
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        px: 1.25,
        py: 1.5
      }}>
      {children}
    </Typography>
  );
}
