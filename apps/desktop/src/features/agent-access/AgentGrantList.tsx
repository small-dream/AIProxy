import { Box, Button, Chip, Divider, Stack, Typography } from "@mui/material";

import type { AgentAccessGrantList, AgentGrant } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";

import { grantCapabilityLabel, grantScopeSummary, grantStatusLabel } from "./agent-grant-format";

export function AgentGrantList({
  busy = false,
  data,
  loading = false,
  onRefresh,
  onRevoke,
  showHeader = true,
}: {
  busy?: boolean;
  data?: AgentAccessGrantList | undefined;
  loading?: boolean;
  onRefresh: () => void;
  onRevoke: (grant: AgentGrant) => void;
  showHeader?: boolean;
}) {
  const { t } = useI18n();
  const grants = (data?.grants ?? []).filter((grant) =>
    ["pending", "approved", "executing"].includes(grant.status),
  );

  return (
    <Box>
      {showHeader ? (
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", justifyContent: "space-between" }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2">{t("settingsPage.agentAccess.grantsTitle")}</Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {t("settingsPage.agentAccess.grantsDescription")}
            </Typography>
          </Box>
          <Button size="small" variant="outlined" disabled={busy || loading} onClick={onRefresh}>
            {loading
              ? t("settingsPage.agentAccess.grantsRefreshing")
              : t("settingsPage.agentAccess.grantsRefresh")}
          </Button>
        </Stack>
      ) : null}
      {grants.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 1.5 }}>
          {t("settingsPage.agentAccess.grantsEmpty")}
        </Typography>
      ) : (
        <Stack divider={<Divider flexItem />} spacing={0} sx={{ mt: 1 }}>
          {grants.map((grant) => {
            const active = grant.status === "approved" || grant.status === "executing";
            return (
              <Stack key={grant.id} spacing={0.75} sx={{ py: 1.25 }}>
                <Stack
                  direction={{ sm: "row", xs: "column" }}
                  spacing={0.75}
                  sx={{
                    alignItems: { sm: "center", xs: "stretch" },
                    justifyContent: "space-between",
                  }}
                >
                  <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
                    <Chip
                      size="small"
                      color={grant.status === "pending" ? "warning" : "success"}
                      variant={grant.status === "pending" ? "filled" : "outlined"}
                      label={grantStatusLabel(grant.status, t)}
                    />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={grantCapabilityLabel(grant.capability, t)}
                    />
                    <Chip size="small" variant="outlined" label={grant.clientName} />
                  </Stack>
                  {active ? (
                    <Button
                      size="small"
                      color="error"
                      variant="outlined"
                      disabled={busy}
                      onClick={() => onRevoke(grant)}
                    >
                      {t("settingsPage.agentAccess.grantRevoke")}
                    </Button>
                  ) : null}
                </Stack>
                <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                  {grant.actionSummary}
                </Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {grantScopeSummary(grant.scope, t)}
                </Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {active
                    ? t("settingsPage.agentAccess.grantExpiresAt", {
                        time: new Date(grant.expiresAt).toLocaleTimeString(),
                        uses: grant.remainingUses,
                      })
                    : t("settingsPage.agentAccess.grantPendingSince", {
                        time: new Date(grant.createdAt).toLocaleTimeString(),
                      })}
                </Typography>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
