import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import {
  Box,
  Button,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";

import type { AgentAuditLog } from "@aiproxy/shared-types";

import { SectionCard } from "@/components/shared/SectionCard";
import { useI18n } from "@/i18n";

type AgentAuditTableProps = {
  data?: AgentAuditLog | undefined;
  loading: boolean;
  onRefresh: () => void;
};

export function AgentAuditTable({ data, loading, onRefresh }: AgentAuditTableProps) {
  const { t } = useI18n();
  const entries = data?.entries ?? [];

  return (
    <SectionCard
      compact
      title={t("settingsPage.agentAccess.auditTitle")}
      description={t("settingsPage.agentAccess.auditDescription")}
      toolbar={
        <Button
          size="small"
          variant="outlined"
          startIcon={<RefreshRoundedIcon />}
          disabled={loading}
          onClick={onRefresh}
          sx={{ minHeight: 32 }}
        >
          {t("settingsPage.agentAccess.auditRefresh")}
        </Button>
      }
    >
      {entries.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", py: 2 }}>
          {t("settingsPage.agentAccess.auditEmpty")}
        </Typography>
      ) : (
        <Box sx={{ overflowX: "auto" }}>
          <Table size="small" sx={{ minWidth: 640 }}>
            <TableHead>
              <TableRow>
                <TableCell>{t("settingsPage.agentAccess.auditTime")}</TableCell>
                <TableCell>{t("settingsPage.agentAccess.auditTool")}</TableCell>
                <TableCell>{t("settingsPage.agentAccess.auditClient")}</TableCell>
                <TableCell>{t("settingsPage.agentAccess.auditOutcome")}</TableCell>
                <TableCell align="right">{t("settingsPage.agentAccess.auditDuration")}</TableCell>
                <TableCell align="right">{t("settingsPage.agentAccess.auditBytes")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((entry, index) => (
                <TableRow key={`${entry.timestamp ?? "entry"}-${index}`}>
                  <TableCell sx={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {entry.timestamp ?? "-"}
                  </TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>{entry.tool ?? "-"}</TableCell>
                  <TableCell>
                    <Stack spacing={0}>
                      <Typography variant="body2">{entry.clientName ?? "unknown"}</Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {entry.clientVersion ?? "-"}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    {entry.outcome ?? "-"}
                    {entry.errorCode ? ` · ${entry.errorCode}` : ""}
                  </TableCell>
                  <TableCell align="right">
                    {entry.durationMs == null ? "-" : `${entry.durationMs} ms`}
                  </TableCell>
                  <TableCell align="right">{entry.returnedBytes ?? "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {data?.truncated ? (
        <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mt: 1 }}>
          {t("settingsPage.agentAccess.auditTruncated")}
        </Typography>
      ) : null}
    </SectionCard>
  );
}
