import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import type {
  AgentAccessGrantList,
  AgentGrant,
  AgentGrantApprovalOption,
} from "@aiproxy/shared-types";
import { coerceAppError } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import {
  approveAgentAccessGrant,
  denyAgentAccessGrant,
  listAgentAccessGrants,
} from "@/services/commands";
import { onAgentGrantChanged, onAgentGrantRequested } from "@/services/events";
import { sendSystemNotification } from "@/services/notifications/system-notifications";

import { AGENT_GRANTS_QUERY_KEY } from "./agent-access-query-keys";
import { grantCapabilityLabel, grantScopeSummary } from "./agent-grant-format";

function upsertGrant(list: AgentAccessGrantList, grant: AgentGrant): AgentAccessGrantList {
  const grants = list.grants.some((item) => item.id === grant.id)
    ? list.grants.map((item) => (item.id === grant.id ? grant : item))
    : [...list.grants, grant];
  return {
    ...list,
    grants,
    pendingCount: grants.filter((item) => item.status === "pending").length,
  };
}

export function AgentGrantApprovalHost() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notified = useRef(new Set<string>());
  const grantsQuery = useQuery({
    queryKey: AGENT_GRANTS_QUERY_KEY,
    queryFn: listAgentAccessGrants,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const update = (grant: AgentGrant) => {
      queryClient.setQueryData<AgentAccessGrantList>(AGENT_GRANTS_QUERY_KEY, (current) =>
        current ? upsertGrant(current, grant) : current,
      );
      void queryClient.invalidateQueries({ queryKey: AGENT_GRANTS_QUERY_KEY });
    };
    void onAgentGrantRequested((grant) => {
      if (cancelled) return;
      update(grant);
      if (!notified.current.has(grant.requestId)) {
        notified.current.add(grant.requestId);
        void sendSystemNotification(
          t("settingsPage.agentAccess.grantNotificationTitle", { client: grant.clientName }),
          t("settingsPage.agentAccess.grantNotificationBody", {
            capability: grantCapabilityLabel(grant.capability, t),
          }),
        );
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlisteners.push(unlisten);
    });
    void onAgentGrantChanged((grant) => {
      if (!cancelled) update(grant);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else unlisteners.push(unlisten);
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [queryClient, t]);

  useEffect(() => {
    const pendingGrants = grantsQuery.data?.grants.filter((grant) => grant.status === "pending");
    for (const grant of pendingGrants ?? []) {
      if (notified.current.has(grant.requestId)) continue;
      notified.current.add(grant.requestId);
      void sendSystemNotification(
        t("settingsPage.agentAccess.grantNotificationTitle", { client: grant.clientName }),
        t("settingsPage.agentAccess.grantNotificationBody", {
          capability: grantCapabilityLabel(grant.capability, t),
        }),
      );
    }
  }, [grantsQuery.data, t]);

  const approveMutation = useMutation({
    mutationFn: ({ requestId, option }: { requestId: string; option: AgentGrantApprovalOption }) =>
      approveAgentAccessGrant({ requestId, option }),
    onSuccess: (grant) => {
      queryClient.setQueryData<AgentAccessGrantList>(AGENT_GRANTS_QUERY_KEY, (current) =>
        current ? upsertGrant(current, grant) : current,
      );
    },
    meta: { suppressGlobalErrorNotification: true },
  });
  const denyMutation = useMutation({
    mutationFn: (requestId: string) => denyAgentAccessGrant({ requestId }),
    onSuccess: (grant) => {
      queryClient.setQueryData<AgentAccessGrantList>(AGENT_GRANTS_QUERY_KEY, (current) =>
        current ? upsertGrant(current, grant) : current,
      );
    },
    meta: { suppressGlobalErrorNotification: true },
  });

  const pending = grantsQuery.data?.grants.find((grant) => grant.status === "pending") ?? null;
  const pendingCount = grantsQuery.data?.pendingCount ?? 0;
  const busy = approveMutation.isPending || denyMutation.isPending;
  const error = approveMutation.error ?? denyMutation.error;
  const allowFifteenMinutes = pending?.approvalOptions.includes("fifteenMinutes") ?? false;

  return (
    <Dialog fullWidth maxWidth="sm" open={pending !== null}>
      {pending ? (
        <>
          <DialogTitle>
            {t("settingsPage.agentAccess.grantDialogTitle", { client: pending.clientName })}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
                <Chip
                  size="small"
                  color="warning"
                  label={grantCapabilityLabel(pending.capability, t)}
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={t("settingsPage.agentAccess.grantRemainingRequests", {
                    count: pendingCount,
                  })}
                />
                {pending.nonIdempotent ? (
                  <Chip
                    size="small"
                    color="error"
                    variant="outlined"
                    label={t("settingsPage.agentAccess.grantNonIdempotentBadge")}
                  />
                ) : null}
              </Stack>
              <Box>
                <Typography variant="subtitle2">
                  {t("settingsPage.agentAccess.grantActionLabel")}
                </Typography>
                <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                  {pending.actionSummary}
                </Typography>
              </Box>
              <Box>
                <Typography variant="subtitle2">
                  {t("settingsPage.agentAccess.grantScopeLabel")}
                </Typography>
                <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                  {grantScopeSummary(pending.scope, t)}
                </Typography>
              </Box>
              <Box>
                <Typography variant="subtitle2">
                  {t("settingsPage.agentAccess.grantReasonLabel")}
                </Typography>
                <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                  {pending.reason}
                </Typography>
              </Box>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {t("settingsPage.agentAccess.grantPermissionDurationHint")}
              </Typography>
              {pending.nonIdempotent ? (
                <Alert severity="warning" variant="outlined">
                  {t("settingsPage.agentAccess.grantNonIdempotentWarning")}
                </Alert>
              ) : null}
              {pending.resourcePolicy ? (
                <Alert severity="info" variant="outlined">
                  {t("settingsPage.agentAccess.grantResourcePolicy", {
                    lifecycle:
                      pending.resourcePolicy.lifecycle === "ephemeral"
                        ? t("settingsPage.agentAccess.grantResourceEphemeral")
                        : t("settingsPage.agentAccess.grantResourcePersistent"),
                    ttl: pending.resourcePolicy.ttlSeconds ?? "-",
                  })}
                </Alert>
              ) : null}
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {t("settingsPage.agentAccess.grantFingerprint", {
                  fingerprint: pending.actionFingerprint,
                })}
              </Typography>
              {error ? <Alert severity="error">{coerceAppError(error).message}</Alert> : null}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button
              color="inherit"
              disabled={busy}
              onClick={() => denyMutation.mutate(pending.requestId)}
            >
              {t("settingsPage.agentAccess.grantDeny")}
            </Button>
            {allowFifteenMinutes ? (
              <Button
                disabled={busy}
                onClick={() =>
                  approveMutation.mutate({
                    requestId: pending.requestId,
                    option: "fifteenMinutes",
                  })
                }
              >
                {t("settingsPage.agentAccess.grantAllowFifteenMinutes")}
              </Button>
            ) : null}
            <Button
              variant="contained"
              disabled={busy}
              onClick={() =>
                approveMutation.mutate({ requestId: pending.requestId, option: "once" })
              }
            >
              {t("settingsPage.agentAccess.grantAllowOnce")}
            </Button>
          </DialogActions>
        </>
      ) : null}
    </Dialog>
  );
}
