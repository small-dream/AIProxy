import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import FilterAltRoundedIcon from "@mui/icons-material/FilterAltRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import {
  Box,
  Button,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";

import type { ThrottleProfile, ThrottleRule } from "@aiproxy/shared-types";

import { MatchTypeSelect } from "@/features/rules/components/MatchTypeSelect";
import { PriorityField } from "@/features/rules/components/PriorityField";
import { HTTP_METHODS, ruleFieldProps, type RuleFieldErrors } from "@/features/rules/rules.helpers";
import type { TranslationKey, TranslationParams } from "@/i18n";
import { EditorHeader } from "./EditorHeader";

export function RuleEditor(props: {
  draft: ThrottleRule | null;
  errors: RuleFieldErrors;
  isError?: boolean;
  profiles: ThrottleProfile[];
  t: (key: TranslationKey, params?: TranslationParams) => string;
  onChange: (patch: Partial<ThrottleRule>) => void;
  onDuplicate: (rule: ThrottleRule) => void;
  onDelete: (ruleId: string) => void;
  onSave: () => void;
  saving: boolean;
  validationAttempted: boolean;
}) {
  const {
    draft,
    errors,
    isError = false,
    profiles,
    t,
    onChange,
    onDuplicate,
    onDelete,
    onSave,
    saving,
    validationAttempted,
  } = props;

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
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", md: "1.2fr 0.8fr" } }}>
        <TextField
          size="small"
          label={t("throttlingPage.ruleFields.name")}
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          {...ruleFieldProps(errors, validationAttempted, "name")}
        />
        <FormControl
          size="small"
          error={ruleFieldProps(errors, validationAttempted, "profileId").error}
        >
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
          {(() => {
            const profileField = ruleFieldProps(errors, validationAttempted, "profileId");
            return profileField.error ? (
              <FormHelperText>{profileField.helperText}</FormHelperText>
            ) : null;
          })()}
        </FormControl>
        <TextField
          size="small"
          label={t("throttlingPage.ruleFields.urlPattern")}
          value={draft.urlPattern}
          onChange={(event) => onChange({ urlPattern: event.target.value })}
          {...ruleFieldProps(errors, validationAttempted, "urlPattern")}
        />
        <MatchTypeSelect
          value={draft.matchType}
          onChange={(matchType) => onChange({ matchType })}
        />
        <FormControl size="small">
          <InputLabel>{t("throttlingPage.ruleFields.methods")}</InputLabel>
          <Select
            multiple
            displayEmpty
            label={t("throttlingPage.ruleFields.methods")}
            value={draft.methods}
            onChange={(event) => onChange({ methods: event.target.value as string[] })}
            // Empty selection means "all methods" — matches the convention used
            // by the other rule panels (see BreakpointRulesPanel / RewriteRulesPanel).
            renderValue={(selected) =>
              selected.length === 0 ? t("rulesPage.allMethods") : selected.join(", ")
            }
          >
            {HTTP_METHODS.map((method) => (
              <MenuItem key={method} value={method}>
                {method}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
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
        <PriorityField
          value={draft.priority}
          onCommit={(priority) => onChange({ priority })}
          label={t("throttlingPage.ruleFields.priority")}
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
          py: 0.75,
        }}
      >
        <Switch
          size="small"
          checked={draft.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
        <Typography variant="body2" sx={{ fontWeight: 650 }}>
          {t("throttlingPage.ruleFields.enabled")}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {t("throttlingPage.ruleFields.enabledHint")}
        </Typography>
      </Stack>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          justifyContent: "space-between",
        }}
      >
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
        py: 1.5,
      }}
    >
      {children}
    </Typography>
  );
}
