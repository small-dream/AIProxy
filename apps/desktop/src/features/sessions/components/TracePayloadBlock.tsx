import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { Box, Button, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "@/i18n";
import { logDevWarn } from "@/services/logger/dev-logger";
import { getSyntaxColors } from "@/themes/app-theme";
import { fontFamilies } from "@/themes/fonts";
import { formatCompactBytes } from "./session-inspector.helpers";
import {
  JSON_HIGHLIGHT_CHAR_LIMIT,
  renderJsonSyntaxHighlightedText,
} from "./SessionInspectorShared";
import {
  formatTracePayload,
  SCRIPT_TRACE_PAYLOAD_LIMIT_BYTES,
  shouldCollapseTracePayload,
  TRACE_PAYLOAD_COLLAPSED_LINES,
} from "./trace-payload.helpers";

const PAYLOAD_LINE_HEIGHT = 1.5;
const COPY_FEEDBACK_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

/**
 * A recorded trace value (script log/extract payload, rewrite before/after).
 * Long values start collapsed to a few lines so one entry cannot push the rest
 * of the automation tab out of view; JSON is pretty-printed and highlighted.
 */
export function TracePayloadBlock({
  originalBytes,
  raw = false,
  value,
}: {
  originalBytes?: number | null | undefined;
  /** Show the value verbatim (no unquoting or re-indenting), e.g. rewrite diffs. */
  raw?: boolean;
  value: string;
}) {
  const { t } = useI18n();
  const paletteMode = useTheme().palette.mode;
  const view = useMemo(() => formatTracePayload(value, { raw }), [raw, value]);
  const collapsible = useMemo(() => shouldCollapseTracePayload(view.text), [view.text]);
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const collapsed = collapsible && !expanded;
  const tokenColors = useMemo(
    () => ({ ...getSyntaxColors(paletteMode), punctuation: "text.primary" }),
    [paletteMode],
  );

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const handleCopy = useCallback(async () => {
    try {
      if (!navigator.clipboard) {
        throw new Error("clipboard API unavailable");
      }
      await navigator.clipboard.writeText(view.text);
      setCopyState("copied");
    } catch (error) {
      logDevWarn("ui.automation", "copy_trace_payload_failed", { error: String(error) });
      setCopyState("failed");
    }
  }, [view.text]);

  const copyTooltip =
    copyState === "copied"
      ? t("contextMenu.copiedToClipboard")
      : copyState === "failed"
        ? t("contextMenu.copyFailed")
        : t("automationTab.copyValue");

  return (
    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
      <Box sx={{ position: "relative" }}>
        <Typography
          component="pre"
          data-collapsed={String(collapsed)}
          data-testid="trace-payload"
          sx={[
            {
              bgcolor: "action.hover",
              borderRadius: "6px",
              fontFamily: fontFamilies.mono,
              fontSize: 12,
              lineHeight: PAYLOAD_LINE_HEIGHT,
              m: 0,
              minHeight: 34,
              overflowWrap: "anywhere",
              p: 1,
              pr: 4.5,
              whiteSpace: "pre-wrap",
            },
            collapsed && {
              maskImage: "linear-gradient(to bottom, #000 65%, transparent)",
              maxHeight: `calc(${TRACE_PAYLOAD_COLLAPSED_LINES} * ${PAYLOAD_LINE_HEIGHT}em + 16px)`,
              overflow: "hidden",
              WebkitMaskImage: "linear-gradient(to bottom, #000 65%, transparent)",
            },
          ]}
        >
          {view.language === "json" && view.text.length <= JSON_HIGHLIGHT_CHAR_LIMIT
            ? renderJsonSyntaxHighlightedText(view.text, tokenColors)
            : view.text}
        </Typography>
        <Tooltip arrow title={copyTooltip}>
          <IconButton
            aria-label={t("automationTab.copyValue")}
            onClick={() => {
              void handleCopy();
            }}
            size="small"
            sx={{ p: 0.5, position: "absolute", right: 4, top: 4 }}
          >
            {copyState === "copied" ? (
              <CheckRoundedIcon sx={{ color: "success.main", fontSize: 16 }} />
            ) : (
              <ContentCopyRoundedIcon sx={{ fontSize: 16 }} />
            )}
          </IconButton>
        </Tooltip>
      </Box>
      {collapsible ? (
        <Button
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          size="small"
          startIcon={expanded ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />}
          sx={{ alignSelf: "flex-start", minHeight: 0, px: 0.75, py: 0.25 }}
        >
          {expanded ? t("automationTab.collapse") : t("automationTab.showAll")}
        </Button>
      ) : null}
      {originalBytes ? (
        <Typography variant="caption" sx={{ color: "warning.main" }}>
          {t("automationTab.payloadTruncated", {
            kept: formatCompactBytes(SCRIPT_TRACE_PAYLOAD_LIMIT_BYTES),
            original: formatCompactBytes(originalBytes),
          })}
        </Typography>
      ) : null}
    </Stack>
  );
}
