import CloudDownloadRoundedIcon from "@mui/icons-material/CloudDownloadRounded";
import CloudUploadRoundedIcon from "@mui/icons-material/CloudUploadRounded";
import SignalCellularAltRoundedIcon from "@mui/icons-material/SignalCellularAltRounded";
import SpeedRoundedIcon from "@mui/icons-material/SpeedRounded";
import { Alert, Box, Button, Slider, Stack, Switch, TextField, Typography } from "@mui/material";
import { useEffect, useState, type ReactNode } from "react";

import type { ThrottleProfile } from "@aiproxy/shared-types";

import type { TranslationKey, TranslationParams } from "@/i18n";
import { ruleFieldProps, type RuleFieldErrors } from "@/features/rules/rules.helpers";
import { fontFamilies } from "@/themes/fonts";
import { EditorHeader } from "./EditorHeader";

export function ProfileEditor(props: {
  active: boolean;
  canSave: boolean;
  draft: ThrottleProfile;
  errors: RuleFieldErrors;
  onChange: (draft: ThrottleProfile) => void;
  onSave: () => void;
  onSaveAndApply: () => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
  validationAttempted: boolean;
}) {
  const {
    active,
    canSave,
    draft,
    errors,
    onChange,
    onSave,
    onSaveAndApply,
    t,
    validationAttempted,
  } = props;
  const parameterErrors = [errors.latencyMs, errors.bandwidth, errors.loss].filter(
    (message): message is string => Boolean(message),
  );

  return (
    <Stack spacing={1.5}>
      <EditorHeader
        icon={<SignalCellularAltRoundedIcon />}
        title={draft.name || t("throttlingPage.customUntitled")}
        subtitle={
          active
            ? t("throttlingPage.profileEditorActiveHint")
            : t("throttlingPage.profileEditorInactiveHint")
        }
      />
      <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
        <TextField
          size="small"
          label={t("throttlingPage.fields.name")}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          {...ruleFieldProps(errors, validationAttempted, "name")}
          sx={{ flex: 1 }}
        />
        <Stack
          direction="row"
          spacing={0.75}
          sx={{
            alignItems: "center",
            border: 1,
            borderColor: "divider",
            borderRadius: "8px",
            px: 1.25,
          }}
        >
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {t("throttlingPage.fields.enableImmediately")}
          </Typography>
          <Switch
            size="small"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
        </Stack>
      </Stack>
      {parameterErrors.length > 0 ? (
        <Alert severity="warning" variant="outlined">
          {parameterErrors.join(" ")}
        </Alert>
      ) : null}
      <Box
        sx={{
          display: "grid",
          gap: 1,
          gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
        }}
      >
        <ThrottleParameter
          icon={<SpeedRoundedIcon />}
          label={t("throttlingPage.fields.latency")}
          max={2000}
          min={0}
          step={10}
          unit="ms"
          value={draft.latencyMs}
          onChange={(value) => onChange({ ...draft, latencyMs: value })}
        />
        <ThrottleParameter
          icon={<SignalCellularAltRoundedIcon />}
          label={t("throttlingPage.fields.loss")}
          max={100}
          min={0}
          step={1}
          unit="%"
          value={draft.packetLossRatio}
          onChange={(value) => onChange({ ...draft, packetLossRatio: value })}
        />
        <ThrottleParameter
          icon={<CloudDownloadRoundedIcon />}
          label={t("throttlingPage.fields.download")}
          max={100000}
          min={1}
          step={100}
          unit="kbps"
          value={draft.downloadKbps}
          onChange={(value) => onChange({ ...draft, downloadKbps: value })}
        />
        <ThrottleParameter
          icon={<CloudUploadRoundedIcon />}
          label={t("throttlingPage.fields.upload")}
          max={50000}
          min={1}
          step={100}
          unit="kbps"
          value={draft.uploadKbps}
          onChange={(value) => onChange({ ...draft, uploadKbps: value })}
        />
      </Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          justifyContent: "flex-end",
        }}
      >
        <Button variant="outlined" onClick={onSave} disabled={!canSave}>
          {t("throttlingPage.saveProfile")}
        </Button>
        <Button variant="contained" onClick={onSaveAndApply} disabled={!canSave}>
          {t("throttlingPage.saveAndApply")}
        </Button>
      </Stack>
    </Stack>
  );
}

export function ThrottleParameter(props: {
  icon: ReactNode;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  unit: string;
  value: number;
}) {
  const { icon, label, max, min, onChange, step, unit, value } = props;
  const sliderValue = Math.min(max, Math.max(min, value));

  // The numeric TextField mirrors the committed value as a string so the user
  // can clear the field without it collapsing to 0 mid-edit (the old
  // `Number(value) || 0` made an empty input instantly snap to 0). The draft is
  // only propagated once the typed text resolves to a finite number; an empty
  // field is held locally and refilled/clamped on blur.
  const [text, setText] = useState(() => String(value));
  useEffect(() => {
    if (value !== Number(text)) {
      setText(String(value));
    }
    // We intentionally only re-sync from the external value; `text` is local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commitClamped = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || text.trim() === "") {
      const clamped = min;
      setText(String(clamped));
      onChange(clamped);
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    if (clamped !== parsed) {
      setText(String(clamped));
    }
    onChange(clamped);
  };

  return (
    <Stack
      spacing={1}
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        p: 1.35,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
        }}
      >
        <Box sx={{ color: "primary.main", display: "flex", "& svg": { fontSize: 18 } }}>{icon}</Box>
        <Typography variant="body2" sx={{ flex: 1, fontWeight: 700 }}>
          {label}
        </Typography>
        <Typography
          sx={{
            color: "text.secondary",
            fontFamily: fontFamilies.mono,
            fontSize: 12,
          }}
        >
          {value} {unit}
        </Typography>
      </Stack>
      <Slider
        size="small"
        min={min}
        max={max}
        step={step}
        value={sliderValue}
        onChange={(_, nextValue) => onChange(Array.isArray(nextValue) ? nextValue[0] : nextValue)}
      />
      <TextField
        size="small"
        type="number"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const parsed = Number(next);
          // Only propagate once the input resolves to a finite number; an empty
          // field is held locally and refilled on blur.
          if (next.trim() !== "" && Number.isFinite(parsed)) {
            onChange(parsed);
          }
        }}
        onBlur={commitClamped}
        slotProps={{ htmlInput: { min, step } }}
        fullWidth
      />
    </Stack>
  );
}
