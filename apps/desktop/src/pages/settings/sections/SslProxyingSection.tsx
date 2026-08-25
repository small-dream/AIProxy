import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import InfoRoundedIcon from "@mui/icons-material/InfoRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  DEFAULT_WORKSPACE_ID,
  coerceAppError,
  type SslProxyEntry,
  type SslProxyingSettings,
  type Workspace,
} from "@aiproxy/shared-types";

import { SectionCard } from "@/components/shared/SectionCard";
import { useProxyStatus, useStartProxy } from "@/features/proxy-status/use-proxy-status";
import { useUpdateWorkspace, useWorkspaces } from "@/features/workspace-manager/use-workspaces";
import { useI18n } from "@/i18n";
import { loadDefaultSslProxyingExclusions } from "@/services/commands";
import { compactAlertSx, compactFieldSx, SettingsRow } from "../SettingsLayoutParts";

const EMPTY_PATTERNS: string[] = [];

function createSslProxyingDraft(
  workspace?: Workspace | null,
  fallbackExclude: string[] = EMPTY_PATTERNS,
): SslProxyingSettings {
  const settings = workspace?.sslProxying;
  return {
    includeEnabled: settings?.includeEnabled ?? false,
    excludeEnabled: settings?.excludeEnabled ?? true,
    include: settings?.include ?? [],
    // A workspace that never configured a policy shows the recommended
    // exclusions (enabled), matching what the backend would actually apply.
    exclude: settings?.exclude ?? fallbackExclude.map((pattern) => ({ pattern, enabled: true })),
  };
}

function sslProxyingSettingsKey(settings: SslProxyingSettings): string {
  return JSON.stringify([
    settings.includeEnabled,
    settings.excludeEnabled,
    // Map to [pattern, enabled] tuples instead of stringifying the entry
    // objects: object key order is an implicit contract that only holds while
    // every construction site happens to write pattern first.
    settings.include.map((entry) => [entry.pattern, entry.enabled]),
    settings.exclude.map((entry) => [entry.pattern, entry.enabled]),
  ]);
}

/**
 * A single rule list with per-entry switches and an add box, shared by the
 * include and exclude lists so both feel identical. Disabled entries are kept
 * around but do not apply, so switching scope never requires deleting rules.
 */
function SslProxyListEditor({
  entries,
  onChange,
  addLabel,
  addPlaceholder,
  emptyText,
}: {
  entries: SslProxyEntry[];
  onChange: (next: SslProxyEntry[]) => void;
  addLabel: string;
  addPlaceholder: string;
  emptyText: string;
}) {
  const { t } = useI18n();
  const [draftPattern, setDraftPattern] = useState("");

  function handleAdd() {
    const pattern = draftPattern.trim();
    if (pattern.length === 0) return;
    // The matcher is case-insensitive, so dedupe case-insensitively too —
    // otherwise API.example.com and api.example.com would both be kept.
    const normalized = pattern.toLowerCase();
    if (!entries.some((entry) => entry.pattern.toLowerCase() === normalized)) {
      onChange([...entries, { pattern, enabled: true }]);
    }
    setDraftPattern("");
  }

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1}>
        <TextField
          size="small"
          fullWidth
          hiddenLabel
          value={draftPattern}
          placeholder={addPlaceholder}
          onChange={(event) => setDraftPattern(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleAdd();
            }
          }}
          slotProps={{ htmlInput: { "aria-label": addLabel } }}
          sx={compactFieldSx}
        />
        <Button
          size="small"
          variant="outlined"
          onClick={handleAdd}
          disabled={draftPattern.trim().length === 0}
          sx={{ minHeight: 34, flexShrink: 0 }}
        >
          {t("sslProxying.add")}
        </Button>
      </Stack>

      {entries.length === 0 ? (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {emptyText}
        </Typography>
      ) : (
        <Box
          sx={{
            maxHeight: 240,
            overflowY: "auto",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1,
            px: 1.5,
            py: 0.5,
          }}
        >
          {entries.map((entry, index) => (
            <Box
              key={entry.pattern}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                py: 0.25,
              }}
            >
              <Typography
                variant="body2"
                sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", lineHeight: 1.4 }}
              >
                {entry.pattern}
              </Typography>
              <Switch
                size="small"
                checked={entry.enabled}
                onChange={(event) =>
                  onChange(
                    entries.map((current, i) =>
                      i === index ? { ...current, enabled: event.target.checked } : current,
                    ),
                  )
                }
                slotProps={{
                  input: {
                    "aria-label": `${entry.enabled ? t("sslProxying.disable") : t("sslProxying.enable")} ${entry.pattern}`,
                  },
                }}
              />
              <IconButton
                size="small"
                aria-label={`${t("sslProxying.remove")} ${entry.pattern}`}
                onClick={() => onChange(entries.filter((_, i) => i !== index))}
              >
                <DeleteRoundedIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
        </Box>
      )}
    </Stack>
  );
}

export function SslProxyingSection() {
  const { t } = useI18n();
  const { data: workspaces = [], isError: isWorkspacesError } = useWorkspaces();
  const { data: proxyStatus } = useProxyStatus();
  const updateWorkspaceMutation = useUpdateWorkspace();
  const startProxyMutation = useStartProxy();
  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const currentWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === workspaceId) ??
      workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID) ??
      null,
    [workspaceId, workspaces],
  );

  // Served by the backend so the recommended list has one source of truth.
  const { data, isError: isRecommendationsError } = useQuery({
    queryKey: ["ssl-proxying", "default-exclusions"],
    queryFn: loadDefaultSslProxyingExclusions,
    staleTime: Infinity,
  });
  // Fall back to a module-level constant rather than a fresh `[]`: this value
  // is an effect dependency, and a new array identity on every render would
  // re-run the effect, call setDraft, and render again without end.
  const recommendedExclusions = data ?? EMPTY_PATTERNS;

  const [draft, setDraft] = useState(createSslProxyingDraft());
  const [feedback, setFeedback] = useState<{
    severity: "error" | "success";
    message: string;
  } | null>(null);

  useEffect(() => {
    setDraft(createSslProxyingDraft(currentWorkspace, recommendedExclusions));
  }, [currentWorkspace, recommendedExclusions]);

  // Clear feedback only when the workspace identity changes, not its content:
  // the post-save refetch produces a new object for the same id, and wiping
  // feedback there would erase the success message handleSave just set.
  const feedbackResetKey = currentWorkspace?.id ?? null;
  useEffect(() => {
    setFeedback(null);
  }, [feedbackResetKey, recommendedExclusions]);

  function patchDraft(patch: Partial<SslProxyingSettings>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setFeedback(null);
  }

  const savedSettings = currentWorkspace?.sslProxying;
  const hasChanges = savedSettings
    ? sslProxyingSettingsKey(savedSettings) !== sslProxyingSettingsKey(draft)
    : sslProxyingSettingsKey({
        includeEnabled: false,
        excludeEnabled: true,
        include: [],
        exclude: recommendedExclusions.map((pattern) => ({ pattern, enabled: true })),
      }) !== sslProxyingSettingsKey(draft);

  // Interception has to be on for the policy to mean anything; saying so is
  // better than letting the user tune a list that is currently inert.
  const isSslDisabled = currentWorkspace ? !currentWorkspace.sslEnabled : false;
  const isAllowlistMode = draft.includeEnabled;

  async function handleSave() {
    if (isWorkspacesError || !currentWorkspace) return;

    setFeedback(null);

    try {
      await updateWorkspaceMutation.mutateAsync({
        sslProxying: draft,
        workspaceId: currentWorkspace.id,
      });

      // The policy is captured when the server starts, so a running proxy has
      // to be restarted before the change takes effect.
      if (proxyStatus?.running) {
        await startProxyMutation.mutateAsync({
          enableSsl: currentWorkspace.sslEnabled,
          enableHttp2: currentWorkspace.http2Enabled ?? true,
          port: currentWorkspace.proxyPort,
          workspaceId: currentWorkspace.id,
        });
      }

      setFeedback({
        message: proxyStatus?.running
          ? t("sslProxying.saveAndApplySuccess")
          : t("sslProxying.saveSuccess"),
        severity: "success",
      });
    } catch (error) {
      const normalizedError = coerceAppError(error);
      setFeedback({
        message: normalizedError.message.trim() || t("common.errors.generic"),
        severity: "error",
      });
    }
  }

  const isBusy = updateWorkspaceMutation.isPending || startProxyMutation.isPending;

  // An unconfigured workspace drafts the recommended exclusions from this
  // query. While that list is unavailable (failed or still loading), saving
  // would persist an empty exclude list and silently drop the protections for
  // known-pinning hosts — block it until the list arrives. Workspaces that
  // already saved a policy are unaffected: their draft comes from the stored
  // settings.
  const isUnconfigured = currentWorkspace?.sslProxying == null;
  const recommendationsUnavailable = data == null;
  const saveBlocked = isUnconfigured && recommendationsUnavailable;

  return (
    <SectionCard compact title={t("sslProxying.title")} description={t("sslProxying.description")}>
      <Stack spacing={1.5}>
        {isWorkspacesError && <Alert severity="error">{t("common.errors.generic")}</Alert>}

        {(isRecommendationsError || saveBlocked) && (
          <Alert severity="warning" variant="outlined" sx={compactAlertSx}>
            {t("sslProxying.recommendationsUnavailable")}
          </Alert>
        )}

        {isSslDisabled && (
          <Alert severity="info" variant="outlined" icon={<InfoRoundedIcon />} sx={compactAlertSx}>
            {t("sslProxying.sslDisabledHint")}
          </Alert>
        )}

        <Stack
          direction={{ md: "row", xs: "column" }}
          spacing={1.5}
          sx={{
            alignItems: { md: "center", xs: "stretch" },
            justifyContent: "space-between",
          }}
        >
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {isAllowlistMode
              ? t("sslProxying.modeIncludeList")
              : t("sslProxying.modeAllExceptExcluded")}
          </Typography>

          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<RestartAltRoundedIcon />}
              onClick={() =>
                patchDraft({
                  exclude: recommendedExclusions.map((pattern) => ({ pattern, enabled: true })),
                  excludeEnabled: true,
                })
              }
              disabled={isBusy || recommendedExclusions.length === 0}
              sx={{ minHeight: 34, px: 1.75 }}
            >
              {t("sslProxying.restoreRecommended")}
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<SaveRoundedIcon />}
              onClick={() => void handleSave()}
              disabled={
                !currentWorkspace || isBusy || !hasChanges || isWorkspacesError || saveBlocked
              }
              sx={{ minHeight: 34, px: 1.75 }}
            >
              {isBusy ? t("sslProxying.saving") : t("sslProxying.save")}
            </Button>
          </Stack>
        </Stack>

        <SettingsRow
          label={t("sslProxying.includeEnabledLabel")}
          description={t("sslProxying.includeEnabledDescription")}
          stacked
        >
          <Switch
            size="small"
            checked={draft.includeEnabled}
            onChange={(event) => patchDraft({ includeEnabled: event.target.checked })}
          />
        </SettingsRow>

        <SettingsRow label={t("sslProxying.include")} stacked>
          <SslProxyListEditor
            entries={draft.include}
            onChange={(include) => patchDraft({ include })}
            addLabel={t("sslProxying.include")}
            addPlaceholder={t("sslProxying.includeAddPlaceholder")}
            emptyText={t("sslProxying.includeEmpty")}
          />
        </SettingsRow>

        <SettingsRow
          label={t("sslProxying.excludeEnabledLabel")}
          description={t("sslProxying.excludeEnabledDescription")}
          stacked
        >
          <Switch
            size="small"
            checked={draft.excludeEnabled}
            onChange={(event) => patchDraft({ excludeEnabled: event.target.checked })}
          />
        </SettingsRow>

        <SettingsRow label={t("sslProxying.exclude")} stacked>
          <SslProxyListEditor
            entries={draft.exclude}
            onChange={(exclude) => patchDraft({ exclude })}
            addLabel={t("sslProxying.exclude")}
            addPlaceholder={t("sslProxying.excludeAddPlaceholder")}
            emptyText={t("sslProxying.excludeEmpty")}
          />
        </SettingsRow>

        <Alert severity="info" variant="outlined" icon={<InfoRoundedIcon />} sx={compactAlertSx}>
          {t("sslProxying.pinningHint")}
        </Alert>

        {feedback && (
          <Alert severity={feedback.severity} variant="outlined" sx={compactAlertSx}>
            {feedback.message}
          </Alert>
        )}
      </Stack>
    </SectionCard>
  );
}
