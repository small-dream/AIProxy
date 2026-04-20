import CodeRoundedIcon from "@mui/icons-material/CodeRounded";
import {
  Alert,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";

import { useI18n } from "@/i18n";
import { listScriptSessionTrace } from "@/services/commands";
import { fontFamilies } from "@/themes/fonts";

export function SessionInspectorAutomationPane({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const { data = [], error, isLoading } = useQuery({
    queryKey: ["script-session-trace", sessionId],
    queryFn: () => listScriptSessionTrace(sessionId),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 160 }}>
        <CircularProgress size={22} />
      </Stack>
    );
  }

  if (error) {
    return (
      <Alert severity="error" variant="outlined">
        {t("automationTab.loadFailed")}
      </Alert>
    );
  }

  if (data.length === 0) {
    return (
      <Typography color="text.secondary" variant="body2">
        {t("automationTab.emptyDescription")}
      </Typography>
    );
  }

  return (
    <Stack spacing={1.5}>
      {data.map((trace, index) => (
        <Paper key={`${trace.ruleId}-${trace.stage}-${index}`} elevation={0} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5 }}>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
              <Stack direction="row" spacing={1} alignItems="center">
                <CodeRoundedIcon sx={{ fontSize: 18, color: "text.secondary" }} />
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {trace.ruleId}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.75} alignItems="center">
                <Chip size="small" label={trace.stage} />
                <Chip size="small" label={trace.outcome} variant="outlined" />
                <Chip size="small" label={`${trace.durationMs} ms`} variant="outlined" />
              </Stack>
            </Stack>

            {trace.entries.length > 0 && <Divider />}

            <Stack spacing={0.75}>
              {trace.entries.map((entry) => (
                <Stack key={`${trace.ruleId}-${trace.stage}-${entry.sequence}`} spacing={0.35}>
                  <Typography variant="caption" color="text.secondary">
                    {entry.kind}{entry.level ? ` • ${entry.level}` : ""}{entry.key ? ` • ${entry.key}` : ""}
                  </Typography>
                  {entry.message && (
                    <Typography variant="body2">
                      {entry.message}
                    </Typography>
                  )}
                  {entry.payloadJson && (
                    <Typography
                      component="pre"
                      sx={{
                        borderRadius: 1.25,
                        bgcolor: "action.hover",
                        fontFamily: fontFamilies.mono,
                        fontSize: 12,
                        m: 0,
                        overflowX: "auto",
                        p: 1,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {entry.payloadJson}
                    </Typography>
                  )}
                </Stack>
              ))}
            </Stack>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}
