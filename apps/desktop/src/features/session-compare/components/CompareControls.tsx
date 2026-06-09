import CompareArrowsRoundedIcon from "@mui/icons-material/CompareArrowsRounded";
import {
  Box,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";

import type { SessionSummary } from "@aiproxy/shared-types";

import type { SessionCompareScopeInput } from "@/features/session-compare/session-behavior-diff.helpers";
import { useI18n } from "@/i18n";

// --- Request compare controls ---

export function RequestCompareControls({
  includeBodyForAi,
  leftId,
  loading,
  onIncludeBodyForAiChange,
  onSelectionChange,
  rightId,
  selectedLeft,
  selectedRight,
  sessions,
}: {
  includeBodyForAi: boolean;
  leftId: string;
  loading: boolean;
  onIncludeBodyForAiChange: (value: boolean) => void;
  onSelectionChange: (left: string, right: string) => void;
  rightId: string;
  selectedLeft?: SessionSummary | undefined;
  selectedRight?: SessionSummary | undefined;
  sessions: SessionSummary[];
}) {
  const { t } = useI18n();

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { md: "minmax(0, 1fr) minmax(0, 1fr)", xs: "1fr" },
        }}
      >
        <RequestSelect
          label={t("comparePage.leftRequest")}
          loading={loading}
          sessions={sessions}
          value={leftId}
          onChange={(value) => onSelectionChange(value, rightId)}
        />
        <RequestSelect
          label={t("comparePage.rightRequest")}
          loading={loading}
          sessions={sessions}
          value={rightId}
          onChange={(value) => onSelectionChange(leftId, value)}
        />
      </Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip
          icon={<CompareArrowsRoundedIcon />}
          label={
            selectedLeft && selectedRight
              ? `${selectedLeft.method} ${selectedLeft.host} -> ${selectedRight.method} ${selectedRight.host}`
              : t("comparePage.pickTwoRequests")
          }
          variant="outlined"
        />
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={includeBodyForAi}
              onChange={(event) => onIncludeBodyForAiChange(event.target.checked)}
            />
          }
          label={<Typography variant="body2">{t("comparePage.includeBody")}</Typography>}
        />
      </Stack>
    </Stack>
  );
}

function RequestSelect({
  label,
  loading,
  onChange,
  sessions,
  value,
}: {
  label: string;
  loading: boolean;
  onChange: (value: string) => void;
  sessions: SessionSummary[];
  value: string;
}) {
  const { t } = useI18n();
  const hasSelectedSession = !value || sessions.some((session) => session.id === value);

  return (
    <FormControl size="small" fullWidth>
      <InputLabel>{label}</InputLabel>
      <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <MenuItem value="">
          {loading ? t("comparePage.loadingSessions") : t("comparePage.selectRequest")}
        </MenuItem>
        {value && !hasSelectedSession ? (
          <MenuItem value={value}>
            {loading ? t("comparePage.loadingSessions") : t("comparePage.missingSession")}
          </MenuItem>
        ) : null}
        {sessions.map((session) => (
          <MenuItem key={session.id} value={session.id}>
            {`${session.method} ${session.host}${session.path} - ${session.statusCode} - ${session.startedAt}`}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

// --- Session compare controls ---

export function SessionCompareControls({
  domainFilter,
  domainOptions,
  leftScopeId,
  onDomainFilterChange,
  onSelectionChange,
  rightScopeId,
  scopes,
}: {
  domainFilter: string[];
  domainOptions: string[];
  leftScopeId: string;
  onDomainFilterChange: (domains: string[]) => void;
  onSelectionChange: (leftScope: string, rightScope: string) => void;
  rightScopeId: string;
  scopes: SessionCompareScopeInput[];
}) {
  const { t } = useI18n();

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { md: "minmax(0, 1fr) minmax(0, 1fr)", xs: "1fr" },
        }}
      >
        <ScopeSelect
          label={t("comparePage.leftSessionScope")}
          scopes={scopes}
          value={leftScopeId}
          onChange={(value) => onSelectionChange(value, rightScopeId)}
        />
        <ScopeSelect
          label={t("comparePage.rightSessionScope")}
          scopes={scopes}
          value={rightScopeId}
          onChange={(value) => onSelectionChange(leftScopeId, value)}
        />
      </Box>
      <FormControl
        size="small"
        fullWidth
        disabled={!leftScopeId || !rightScopeId || domainOptions.length === 0}
      >
        <InputLabel>{t("comparePage.domainFilter")}</InputLabel>
        <Select
          multiple
          label={t("comparePage.domainFilter")}
          value={domainFilter}
          renderValue={(selected) =>
            selected.length === 0 ? t("comparePage.allDomains") : selected.join(", ")
          }
          onChange={(event) => {
            const value = event.target.value;
            onDomainFilterChange(typeof value === "string" ? value.split(",") : value);
          }}
        >
          {domainOptions.map((domain) => (
            <MenuItem key={domain} value={domain}>
              <Checkbox checked={domainFilter.includes(domain)} />
              <ListItemText primary={domain} />
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Chip
        icon={<CompareArrowsRoundedIcon />}
        label={
          leftScopeId && rightScopeId
            ? t("comparePage.sessionBehaviorReady")
            : t("comparePage.pickTwoSessionScopes")
        }
        variant="outlined"
      />
    </Stack>
  );
}

function ScopeSelect({
  label,
  onChange,
  scopes,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  scopes: SessionCompareScopeInput[];
  value: string;
}) {
  const { t } = useI18n();
  const hasSelectedScope = !value || scopes.some((scope) => scope.id === value);

  return (
    <FormControl size="small" fullWidth>
      <InputLabel>{label}</InputLabel>
      <Select
        label={label}
        value={hasSelectedScope ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <MenuItem value="">{t("comparePage.selectSessionScope")}</MenuItem>
        {scopes.map((scope) => (
          <MenuItem key={scope.id} value={scope.id}>
            {`${scope.label} - ${t("comparePage.requestCount", { count: scope.sessions.length })}`}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
