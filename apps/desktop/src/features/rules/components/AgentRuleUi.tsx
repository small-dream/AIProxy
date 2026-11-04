import { Alert, Button, Stack, Typography } from "@mui/material";
import { useState } from "react";

import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { useClearAgentRules } from "@/features/rules/use-rule-center";
import { useI18n, type SupportedLocale } from "@/i18n";
import { useNotificationStore } from "@/services/notification.store";

export function formatAgentRuleExpiry(expiresAt: string | undefined, locale: SupportedLocale) {
  if (!expiresAt) return "";
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function AgentRulesNotice({
  persistentCount,
  temporaryCount,
}: {
  persistentCount: number;
  temporaryCount: number;
}) {
  const { t } = useI18n();
  const clearMutation = useClearAgentRules();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (temporaryCount === 0 && persistentCount === 0) return null;

  return (
    <>
      <Alert
        severity="warning"
        action={
          temporaryCount > 0 ? (
            <Button
              color="inherit"
              disabled={clearMutation.isPending}
              onClick={() => setConfirmOpen(true)}
              size="small"
            >
              {t("rulesPage.agentRule.clearAction")}
            </Button>
          ) : undefined
        }
        sx={{ alignItems: "center", mb: 1, py: 0.25 }}
      >
        <Stack spacing={0.25}>
          {temporaryCount > 0 ? (
            <Typography variant="body2">
              {t("rulesPage.agentRule.notice", { count: temporaryCount })}
            </Typography>
          ) : null}
          {persistentCount > 0 ? (
            <Typography variant="body2">
              {t("rulesPage.agentRule.persistentNotice", { count: persistentCount })}
            </Typography>
          ) : null}
        </Stack>
      </Alert>
      <ConfirmDialog
        cancelLabel={t("common.actions.cancel")}
        confirmColor="warning"
        confirmLabel={t("rulesPage.agentRule.clearAction")}
        isConfirming={clearMutation.isPending}
        message={t("rulesPage.agentRule.clearConfirmMessage")}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          clearMutation.mutate(undefined, {
            onSuccess: (removedCount) => {
              setConfirmOpen(false);
              useNotificationStore
                .getState()
                .push(t("rulesPage.agentRule.cleared", { count: removedCount }), "success");
            },
          });
        }}
        open={confirmOpen}
        title={t("rulesPage.agentRule.clearConfirmTitle")}
      />
    </>
  );
}

export function AgentRuleReadOnlyNotice({
  expiresAt,
  lifecycle,
}: {
  expiresAt?: string | undefined;
  lifecycle?: "persistent" | "ephemeral" | undefined;
}) {
  const { t, locale } = useI18n();

  if (lifecycle === "persistent") {
    return <Alert severity="info">{t("rulesPage.agentRule.readOnlyPersistentDescription")}</Alert>;
  }

  return (
    <Alert severity="info">
      {t("rulesPage.agentRule.readOnlyDescription", {
        time: formatAgentRuleExpiry(expiresAt, locale),
      })}
    </Alert>
  );
}
