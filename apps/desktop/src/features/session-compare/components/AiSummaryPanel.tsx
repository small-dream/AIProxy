import AutoFixHighRoundedIcon from "@mui/icons-material/AutoFixHighRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from "@mui/material";

import { coerceAppError } from "@aiproxy/shared-types";

import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { useI18n } from "@/i18n";

export function AiSummaryPanel({
  aiConfigured,
  model,
  mutationData,
  mutationError,
  onConfigure,
}: {
  aiConfigured: boolean;
  model?: string | undefined;
  mutationData?: string | undefined;
  mutationError: unknown;
  onConfigure: () => void;
}) {
  const { t } = useI18n();

  return (
    <Paper
      elevation={0}
      sx={{ border: 1, borderColor: "divider", borderRadius: 2, overflow: "hidden" }}
    >
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          justifyContent="space-between"
          sx={{ borderBottom: 1, borderColor: "divider", px: 1.5, py: 1 }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <AutoFixHighRoundedIcon sx={{ color: "primary.main", fontSize: 20 }} />
            <Typography variant="subtitle1" sx={{ fontWeight: 750 }}>
              {t("comparePage.aiSummary")}
            </Typography>
          </Stack>
          {model ? <Chip size="small" label={model} variant="outlined" /> : null}
        </Stack>
        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
          {!aiConfigured ? (
            <Stack spacing={1.5}>
              <Alert severity="info">{t("comparePage.aiNotConfigured")}</Alert>
              <Button variant="outlined" startIcon={<SettingsRoundedIcon />} onClick={onConfigure}>
                {t("comparePage.configureAi")}
              </Button>
            </Stack>
          ) : mutationError ? (
            <Alert severity="error">{coerceAppError(mutationError).message}</Alert>
          ) : mutationData ? (
            <MarkdownRenderer density="compact">{mutationData}</MarkdownRenderer>
          ) : (
            <Alert severity="info">{t("comparePage.summaryIdle")}</Alert>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}
