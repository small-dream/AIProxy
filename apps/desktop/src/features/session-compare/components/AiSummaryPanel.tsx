import AutoFixHighRoundedIcon from "@mui/icons-material/AutoFixHighRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import ReactMarkdown from "react-markdown";

import { coerceAppError } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";

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
            <ReactMarkdown components={markdownComponents}>{mutationData}</ReactMarkdown>
          ) : (
            <Alert severity="info">{t("comparePage.summaryIdle")}</Alert>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  h1: ({ children }) => (
    <Typography component="h1" sx={{ fontSize: 18, fontWeight: 750, mt: 1.5, mb: 0.75 }}>
      {children}
    </Typography>
  ),
  h2: ({ children }) => (
    <Typography component="h2" sx={{ fontSize: 16, fontWeight: 750, mt: 1.5, mb: 0.75 }}>
      {children}
    </Typography>
  ),
  h3: ({ children }) => (
    <Typography component="h3" sx={{ fontSize: 14, fontWeight: 750, mt: 1.25, mb: 0.5 }}>
      {children}
    </Typography>
  ),
  p: ({ children }) => (
    <Typography component="p" sx={{ fontSize: 13, lineHeight: 1.7, mb: 1 }}>
      {children}
    </Typography>
  ),
  strong: ({ children }) => (
    <Box component="strong" sx={{ fontWeight: 700 }}>
      {children}
    </Box>
  ),
  em: ({ children }) => (
    <Box component="em" sx={{ fontStyle: "italic" }}>
      {children}
    </Box>
  ),
  code: ({ children }) => (
    <Box
      component="code"
      sx={{
        fontFamily: fontFamilies.mono,
        fontSize: 12,
        bgcolor: "action.hover",
        borderRadius: 0.5,
        px: 0.5,
        py: 0.25,
      }}
    >
      {children}
    </Box>
  ),
  pre: ({ children }) => (
    <Box
      component="pre"
      sx={{
        fontFamily: fontFamilies.mono,
        fontSize: 12,
        bgcolor: "action.hover",
        borderRadius: 1,
        p: 1,
        overflowX: "auto",
        mb: 1,
      }}
    >
      {children}
    </Box>
  ),
  ul: ({ children }) => (
    <Box component="ul" sx={{ pl: 2.5, mb: 1, fontSize: 13, lineHeight: 1.7 }}>
      {children}
    </Box>
  ),
  ol: ({ children }) => (
    <Box component="ol" sx={{ pl: 2.5, mb: 1, fontSize: 13, lineHeight: 1.7 }}>
      {children}
    </Box>
  ),
  li: ({ children }) => (
    <Box component="li" sx={{ mb: 0.25 }}>
      {children}
    </Box>
  ),
  a: ({ children, href }) => (
    <Typography
      component="a"
      href={href}
      sx={{ fontSize: 13, color: "primary.main", textDecoration: "underline" }}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </Typography>
  ),
  blockquote: ({ children }) => (
    <Box
      component="blockquote"
      sx={{
        borderLeft: 2,
        borderColor: "divider",
        pl: 1.5,
        my: 1,
        color: "text.secondary",
        fontSize: 13,
      }}
    >
      {children}
    </Box>
  ),
  hr: () => <Divider sx={{ my: 1.5 }} />,
  table: ({ children }) => (
    <TableContainer component={Box} sx={{ mb: 1 }}>
      <Table size="small">{children}</Table>
    </TableContainer>
  ),
  thead: ({ children }) => <TableHead>{children}</TableHead>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableCell sx={{ fontWeight: 700, fontSize: 12 }}>{children}</TableCell>,
  td: ({ children }) => <TableCell sx={{ fontSize: 12 }}>{children}</TableCell>,
};
