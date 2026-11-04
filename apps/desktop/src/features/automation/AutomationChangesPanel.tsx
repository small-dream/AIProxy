import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from "@mui/material";
import type {
  AutomationChangeItem,
  AutomationChangeView,
  AutomationVerificationRecord,
  AutomationVerificationRequestResult,
} from "@aiproxy/shared-types";
import { useEffect, useMemo, useState } from "react";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import {
  useAutomationChanges,
  useClearAgentAutomation,
  usePromoteAutomationChange,
  useRollbackAutomationChange,
} from "@/features/automation/use-automation-changes";
import { useI18n, type TranslationKey } from "@/i18n";
import { useNotificationStore } from "@/services/notification.store";

import {
  VERIFICATION_MODES,
  formatAutomationDate,
  formatAutomationValue,
  groupAutomationVerifications,
} from "./automation-changes.helpers";

type PendingAction = "rollback" | "promote" | "clear";

function statusLabelKey(status: string): TranslationKey | null {
  switch (status) {
    case "aborted":
    case "active":
    case "assertion_failed":
    case "committed":
    case "expired":
    case "insufficient_evidence":
    case "not_matched":
    case "prepared":
    case "promoted":
    case "publish_failed":
    case "reverted":
    case "reverting":
    case "rule_failed":
    case "shadowed":
    case "upstream_failed":
      return `rulesPage.agentExperiment.statusValue.${status}`;
    default:
      return null;
  }
}

function statusColor(status: string): "default" | "error" | "info" | "success" | "warning" {
  if (status === "active" || status === "passed") return "success";
  if (status === "promoted") return "info";
  if (
    status === "publish_failed" ||
    status === "rule_failed" ||
    status === "upstream_failed" ||
    status === "assertion_failed"
  ) {
    return "error";
  }
  if (
    status === "shadowed" ||
    status === "not_matched" ||
    status === "insufficient_evidence" ||
    status === "expired"
  ) {
    return "warning";
  }
  return "default";
}

function resourceName(item: AutomationChangeItem): string {
  const resource = item.after ?? item.before;
  if (resource && typeof resource === "object") {
    const name = (resource as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name;
  }
  return item.resourceId;
}

function assertionExpected(record: AutomationVerificationRecord, assertionId: string): unknown {
  return record.assertions.find((assertion) => assertion.id === assertionId)?.expected;
}

function assertionDefinition(
  record: AutomationVerificationRecord,
  assertionId: string,
): { subject?: string | undefined; path?: string | undefined; operator?: string | undefined } {
  const assertion = record.assertions.find((entry) => entry.id === assertionId);
  return {
    subject: assertion?.subject,
    path: assertion?.path,
    operator: assertion?.operator,
  };
}

function VerificationRequest({
  record,
  request,
}: {
  record: AutomationVerificationRecord;
  request: AutomationVerificationRequestResult;
}) {
  const { t } = useI18n();
  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="caption" sx={{ fontFamily: "monospace", fontWeight: 700 }}>
          {request.ref}
        </Typography>
        <Chip
          color={statusColor(request.status)}
          label={
            statusLabelKey(request.status) ? t(statusLabelKey(request.status)!) : request.status
          }
          size="small"
          sx={{ height: 20, fontSize: 11 }}
        />
        {request.responseStatus ? (
          <Chip label={`HTTP ${request.responseStatus}`} size="small" variant="outlined" />
        ) : null}
      </Stack>
      {request.finalUrl ? (
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", display: "block", mt: 0.5, wordBreak: "break-all" }}
        >
          {request.finalUrl}
        </Typography>
      ) : null}
      {request.matchedRuleIds.length ? (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", mt: 0.75 }}>
          {request.matchedRuleIds.map((id) => (
            <Chip key={id} label={id} size="small" variant="outlined" />
          ))}
        </Stack>
      ) : null}
      <Stack spacing={0.5} sx={{ mt: 0.75 }}>
        {request.assertions.length === 0 ? (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("rulesPage.agentExperiment.noAssertions")}
          </Typography>
        ) : (
          request.assertions.map((assertion) => {
            const definition = assertionDefinition(record, assertion.id);
            return (
              <Box
                key={assertion.id}
                sx={{
                  bgcolor: (theme) =>
                    assertion.passed
                      ? theme.palette.success.main + "0f"
                      : theme.palette.error.main + "0f",
                  borderRadius: 0.75,
                  p: 0.75,
                }}
              >
                <Stack
                  direction="row"
                  spacing={0.75}
                  sx={{ alignItems: "center", flexWrap: "wrap" }}
                >
                  <Chip
                    color={assertion.passed ? "success" : "error"}
                    label={assertion.passed ? "PASS" : "FAIL"}
                    size="small"
                    sx={{ height: 18, fontSize: 10 }}
                  />
                  <Typography variant="caption" sx={{ fontWeight: 650 }}>
                    {definition.subject ?? assertion.id}
                    {definition.path ? ` · ${definition.path}` : ""}
                    {definition.operator ? ` · ${definition.operator}` : ""}
                  </Typography>
                </Stack>
                <Typography variant="caption" sx={{ display: "block", mt: 0.5 }}>
                  {assertion.message}
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    fontFamily: "monospace",
                    fontSize: 11,
                    m: 0,
                    mt: 0.5,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {t("rulesPage.agentExperiment.expected")}:{" "}
                  {formatAutomationValue(assertionExpected(record, assertion.id))}
                  {"\n"}
                  {t("rulesPage.agentExperiment.actual")}: {formatAutomationValue(assertion.actual)}
                </Box>
              </Box>
            );
          })
        )}
      </Stack>
      {request.conflict ? (
        <Alert severity="warning" sx={{ mt: 0.75, py: 0.25 }}>
          <Typography variant="caption" sx={{ fontWeight: 700 }}>
            {t("rulesPage.agentExperiment.conflict")}
          </Typography>
          {request.conflict.winningRuleId ? (
            <Typography variant="caption" sx={{ display: "block" }}>
              {t("rulesPage.agentExperiment.winningRule")}: {request.conflict.winningRuleId}
            </Typography>
          ) : null}
          {(request.conflict.candidates ?? []).map((candidate) => (
            <Typography key={candidate.ruleId} variant="caption" sx={{ display: "block", mt: 0.4 }}>
              {candidate.ruleName ?? candidate.ruleId} · p{candidate.priority}
              {candidate.sourcePattern ? ` · ${candidate.sourcePattern}` : ""} — {candidate.reason}
            </Typography>
          ))}
        </Alert>
      ) : null}
    </Box>
  );
}

function VerificationRecordView({ record }: { record: AutomationVerificationRecord }) {
  const { t } = useI18n();
  const statusKey = statusLabelKey(record.result.status);
  return (
    <Accordion disableGutters elevation={0} sx={{ border: 1, borderColor: "divider" }}>
      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon fontSize="small" />}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Chip
            color={statusColor(record.result.status)}
            label={statusKey ? t(statusKey) : record.result.status}
            size="small"
          />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {formatAutomationDate(record.createdAt, record.createdAt)}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("rulesPage.agentExperiment.evidenceLevel")}: {record.result.evidenceLevel}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("rulesPage.agentExperiment.runtimeGeneration")}: {record.result.runtimeGeneration}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <Stack spacing={1}>
          {record.result.requests.map((request) => (
            <VerificationRequest key={request.ref} record={record} request={request} />
          ))}
          <Box>
            <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 700 }}>
              {t("rulesPage.agentExperiment.limitations")}
            </Typography>
            {record.limitations.length === 0 ? (
              <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
                {t("rulesPage.agentExperiment.noLimitations")}
              </Typography>
            ) : (
              record.limitations.map((limitation) => (
                <Typography key={limitation} variant="caption" sx={{ display: "block" }}>
                  • {limitation}
                </Typography>
              ))
            )}
          </Box>
          {record.evidenceSessionIds.length > 0 ? (
            <Box>
              <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 700 }}>
                {t("rulesPage.agentExperiment.evidenceSessions")}
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", mt: 0.25 }}>
                {record.evidenceSessionIds.map((id) => (
                  <Chip key={id} label={id} size="small" variant="outlined" />
                ))}
              </Stack>
            </Box>
          ) : null}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

function ChangeDetail({
  change,
  onAction,
  isPending,
  errorMessage,
}: {
  change: AutomationChangeView;
  onAction: (action: PendingAction) => void;
  isPending: boolean;
  errorMessage?: string | undefined;
}) {
  const { t } = useI18n();
  const grouped = useMemo(
    () => groupAutomationVerifications(change.verifications),
    [change.verifications],
  );
  const statusKey = statusLabelKey(change.status);
  const canPersistentAction = change.lifecycle === "persistent" && change.status === "active";

  return (
    <Stack spacing={1.25} sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>
          {change.changeId}
        </Typography>
        <Chip
          color={statusColor(change.status)}
          label={statusKey ? t(statusKey) : change.status}
          size="small"
        />
        <Chip
          label={t(`rulesPage.agentExperiment.lifecycle.${change.lifecycle}`)}
          size="small"
          variant="outlined"
        />
        <Chip
          label={t(`rulesPage.agentExperiment.scopes.${change.scope}`)}
          size="small"
          variant="outlined"
        />
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.25, sm: 2 }}>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("rulesPage.agentExperiment.workspace")}: {change.workspaceId ?? "—"}
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("rulesPage.agentExperiment.runtimeGeneration")}: {change.runtimeGeneration ?? "—"}
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("rulesPage.agentExperiment.created")}:{" "}
          {formatAutomationDate(change.createdAt, change.createdAt)}
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("rulesPage.agentExperiment.expiresAt")}: {formatAutomationDate(change.expiresAt, "—")}
        </Typography>
      </Stack>
      <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap" }}>
        <Button
          disabled={!canPersistentAction || isPending}
          onClick={() => onAction("rollback")}
          size="small"
          variant="outlined"
        >
          {t("rulesPage.agentExperiment.actions.rollback")}
        </Button>
        <Button
          disabled={!canPersistentAction || isPending}
          onClick={() => onAction("promote")}
          size="small"
          variant="outlined"
        >
          {t("rulesPage.agentExperiment.actions.promote")}
        </Button>
        <Button
          color="warning"
          disabled={change.lifecycle !== "ephemeral" || isPending}
          onClick={() => onAction("clear")}
          size="small"
          variant="outlined"
        >
          {t("rulesPage.agentExperiment.actions.clearEphemeral")}
        </Button>
      </Stack>
      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}

      {change.experiment ? (
        <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {t("rulesPage.agentExperiment.experiment")}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {t("rulesPage.agentExperiment.objective")}: {change.experiment.objective}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {t("rulesPage.agentExperiment.cleanupState")}: {change.experiment.cleanupState}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {t("rulesPage.agentExperiment.baselineSessions")}:{" "}
            {change.experiment.baselineSessionIds.length
              ? change.experiment.baselineSessionIds.join(", ")
              : t("rulesPage.agentExperiment.noBaseline")}
          </Typography>
        </Box>
      ) : null}

      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
          {t("rulesPage.agentExperiment.items")}
        </Typography>
        {change.items.length === 0 ? (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("rulesPage.agentExperiment.noItems")}
          </Typography>
        ) : (
          <Stack spacing={0.75}>
            {change.items.map((item) => (
              <Accordion
                disableGutters
                elevation={0}
                key={`${item.resourceKind}:${item.resourceId}:${item.operation}`}
                sx={{ border: 1, borderColor: "divider" }}
              >
                <AccordionSummary expandIcon={<ExpandMoreRoundedIcon fontSize="small" />}>
                  <Stack
                    direction="row"
                    spacing={0.75}
                    sx={{ alignItems: "center", flexWrap: "wrap" }}
                  >
                    <Chip
                      label={t(`rulesPage.agentExperiment.operations.${item.operation}`)}
                      size="small"
                      variant="outlined"
                    />
                    <Typography variant="body2" sx={{ fontWeight: 650 }}>
                      {resourceName(item)}
                    </Typography>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      {item.resourceKind} · {item.resourceId}
                    </Typography>
                  </Stack>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0 }}>
                  <Divider sx={{ mb: 0.75 }} />
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {t("rulesPage.agentExperiment.version")}: {item.versionBefore ?? "—"} →{" "}
                    {item.versionAfter ?? "—"}
                  </Typography>
                  <Box
                    component="pre"
                    sx={{
                      fontFamily: "monospace",
                      fontSize: 11,
                      m: 0,
                      mt: 0.75,
                      maxHeight: 260,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {formatAutomationValue(item.after ?? item.before)}
                  </Box>
                </AccordionDetails>
              </Accordion>
            ))}
          </Stack>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
          {t("rulesPage.agentExperiment.assertions")}
        </Typography>
        {change.verifications.length === 0 ? (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("rulesPage.agentExperiment.noVerifications")}
          </Typography>
        ) : (
          <Stack spacing={1}>
            {VERIFICATION_MODES.map((mode) => (
              <Box key={mode}>
                <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 700 }}>
                  {t(`rulesPage.agentExperiment.modes.${mode}`)} · {grouped[mode].length}
                </Typography>
                <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                  {grouped[mode].map((record) => (
                    <VerificationRecordView key={record.id} record={record} />
                  ))}
                </Stack>
              </Box>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

export function AutomationChangesPanel() {
  const { t } = useI18n();
  const changesQuery = useAutomationChanges(20);
  const rollbackMutation = useRollbackAutomationChange();
  const promoteMutation = usePromoteAutomationChange();
  const clearMutation = useClearAgentAutomation();
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const changes = useMemo(() => changesQuery.data ?? [], [changesQuery.data]);
  useEffect(() => {
    if (changes.length === 0) {
      setSelectedChangeId(null);
      return;
    }
    setSelectedChangeId((current) =>
      current && changes.some((change) => change.changeId === current)
        ? current
        : changes[0]!.changeId,
    );
  }, [changes]);

  const selectedChange = changes.find((change) => change.changeId === selectedChangeId) ?? null;
  const isPending =
    rollbackMutation.isPending || promoteMutation.isPending || clearMutation.isPending;

  async function confirmAction() {
    if (!selectedChange || !pendingAction) return;
    setActionError(null);
    try {
      if (pendingAction === "rollback") {
        await rollbackMutation.mutateAsync({
          changeId: selectedChange.changeId,
          expectedScopeHash: selectedChange.rollbackScopeHash,
        });
        useNotificationStore
          .getState()
          .push(t("rulesPage.agentExperiment.success.rollback"), "success");
      } else if (pendingAction === "promote") {
        await promoteMutation.mutateAsync(selectedChange.changeId);
        useNotificationStore
          .getState()
          .push(t("rulesPage.agentExperiment.success.promote"), "success");
      } else {
        const result = await clearMutation.mutateAsync({
          scope: selectedChange.scope,
          lifecycle: "ephemeral",
          ...(selectedChange.workspaceId ? { workspaceId: selectedChange.workspaceId } : {}),
        });
        useNotificationStore.getState().push(
          t("rulesPage.agentExperiment.success.clear", {
            count: result.clearedResourceCount,
          }),
          "success",
        );
      }
      setPendingAction(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  const dialog = (() => {
    if (!selectedChange || !pendingAction) return null;
    switch (pendingAction) {
      case "rollback":
        return {
          title: t("rulesPage.agentExperiment.confirm.rollbackTitle"),
          message: t("rulesPage.agentExperiment.confirm.rollbackMessage"),
          confirmLabel: t("rulesPage.agentExperiment.actions.rollback"),
          confirmColor: "warning" as const,
        };
      case "promote":
        return {
          title: t("rulesPage.agentExperiment.confirm.promoteTitle"),
          message: t("rulesPage.agentExperiment.confirm.promoteMessage"),
          confirmLabel: t("rulesPage.agentExperiment.actions.promote"),
          confirmColor: "primary" as const,
        };
      case "clear":
        return {
          title: t("rulesPage.agentExperiment.confirm.clearTitle"),
          message: t("rulesPage.agentExperiment.confirm.clearMessage"),
          confirmLabel: t("rulesPage.agentExperiment.actions.clearEphemeral"),
          confirmColor: "warning" as const,
        };
    }
  })();

  if (changesQuery.isLoading) {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {t("common.states.loading")}
      </Typography>
    );
  }

  if (changesQuery.isError) {
    return <Alert severity="error">{String(changesQuery.error)}</Alert>;
  }

  if (changes.length === 0) {
    return (
      <Stack
        spacing={1}
        sx={{
          alignItems: "center",
          border: 1,
          borderColor: "divider",
          borderRadius: 1.25,
          justifyContent: "center",
          minHeight: 260,
          px: 2,
          textAlign: "center",
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          {t("rulesPage.agentExperiment.emptyTitle")}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", maxWidth: 560 }}>
          {t("rulesPage.agentExperiment.emptyDescription")}
        </Typography>
      </Stack>
    );
  }

  return (
    <>
      <Stack direction={{ xs: "column", lg: "row" }} spacing={1.25} sx={{ alignItems: "stretch" }}>
        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1.25,
            flexShrink: 0,
            maxHeight: { xs: 300, lg: "calc(100vh - 210px)" },
            overflow: "auto",
            p: 1,
            width: { xs: "100%", lg: 330 },
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 750, px: 0.75, py: 0.5 }}>
            {t("rulesPage.agentExperiment.title")}
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", display: "block", px: 0.75, pb: 0.75 }}
          >
            {t("rulesPage.agentExperiment.description")}
          </Typography>
          <List dense disablePadding>
            {changes.map((change) => {
              const statusKey = statusLabelKey(change.status);
              return (
                <ListItemButton
                  key={change.changeId}
                  onClick={() => {
                    setSelectedChangeId(change.changeId);
                    setActionError(null);
                  }}
                  selected={change.changeId === selectedChangeId}
                  sx={{ border: 1, borderColor: "divider", borderRadius: 1, mb: 0.5 }}
                >
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                          {change.changeId}
                        </Typography>
                        <Chip
                          color={statusColor(change.status)}
                          label={statusKey ? t(statusKey) : change.status}
                          size="small"
                          sx={{ height: 18, fontSize: 10 }}
                        />
                      </Stack>
                    }
                    secondary={
                      <Stack spacing={0.25} sx={{ mt: 0.35 }}>
                        <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
                          {t(`rulesPage.agentExperiment.lifecycle.${change.lifecycle}`)} ·{" "}
                          {change.items.length} · gen {change.runtimeGeneration ?? "—"}
                        </Typography>
                        <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
                          {formatAutomationDate(change.createdAt, change.createdAt)}
                        </Typography>
                      </Stack>
                    }
                  />
                </ListItemButton>
              );
            })}
          </List>
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {selectedChange ? (
            <ChangeDetail
              change={selectedChange}
              errorMessage={actionError ?? undefined}
              isPending={isPending}
              onAction={(action) => {
                setActionError(null);
                setPendingAction(action);
              }}
            />
          ) : (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("rulesPage.agentExperiment.actions.missingSelection")}
            </Typography>
          )}
        </Box>
      </Stack>
      <ConfirmDialog
        cancelLabel={t("common.actions.cancel")}
        confirmColor={dialog?.confirmColor ?? "warning"}
        {...(dialog?.confirmLabel ? { confirmLabel: dialog.confirmLabel } : {})}
        isConfirming={isPending}
        message={dialog?.message ?? ""}
        onCancel={() => {
          if (!isPending) setPendingAction(null);
        }}
        onConfirm={() => {
          void confirmAction();
        }}
        open={Boolean(dialog)}
        title={dialog?.title ?? ""}
      />
    </>
  );
}
