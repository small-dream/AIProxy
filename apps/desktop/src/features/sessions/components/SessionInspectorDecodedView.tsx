import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  coerceAppError,
  type ScriptDecodeResult,
  type ScriptDecoderRef,
  type SessionSummary,
} from "@aiproxy/shared-types";
import { useState } from "react";

import { useI18n } from "@/i18n";
import { fontFamilies } from "@/themes/fonts";
import { useScriptDecode, type DecodeStage } from "../use-script-decode";
import type { DecodedBodyView } from "./decoded-body.helpers";
import { formatCompactBytes, type SearchMatcher } from "./session-inspector.helpers";
import { SearchableCodeBlock } from "./SessionInspectorShared";
import { SessionInspectorJsonTree } from "./SessionInspectorJsonTree";
import { TracePayloadBlock } from "./TracePayloadBlock";

/** Mirrors `MAX_DECODED_BODY_BYTES` in crates/rule-engine/src/types.rs. */
const DECODED_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

type ViewMode = "tree" | "text";

/**
 * The inspector's Decoded tab: runs the matching script rule's read-only
 * decode hook on demand and shows the result with the JSON tree / text views.
 */
export function SessionInspectorDecodedView({
  currentMatchIndex,
  decoder,
  onMatchCountChange,
  onSearchWithText,
  searchMatcher,
  session,
  stage,
}: {
  currentMatchIndex?: number | undefined;
  decoder: ScriptDecoderRef;
  onMatchCountChange?: ((count: number) => void) | undefined;
  onSearchWithText?: ((text: string) => void) | undefined;
  searchMatcher: SearchMatcher | null;
  session: SessionSummary;
  stage: DecodeStage;
}) {
  const { t } = useI18n();
  const query = useScriptDecode(session, stage, decoder.ruleId);
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [logsOpen, setLogsOpen] = useState(false);
  const result = query.data?.result;
  const decoded = result?.decoded ?? null;
  const view = query.data?.view ?? null;
  const treeAvailable = view?.language === "json" && view.treeAvailable;
  const effectiveMode: ViewMode = treeAvailable ? viewMode : "text";
  const ruleName = result?.ruleName ?? decoder.ruleName;
  const entries = result?.entries ?? [];

  if (query.isPending) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", py: 1 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("inspector.decoded.decoding", { rule: decoder.ruleName })}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
      {/* Controls sit on the left: the pane's floating search bar covers the top-right. */}
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", minHeight: 30 }}>
        {treeAvailable ? (
          <ToggleButtonGroup
            aria-label={t("inspector.decoded.viewMode")}
            exclusive
            onChange={(_event, next: ViewMode | null) => {
              if (next) setViewMode(next);
            }}
            size="small"
            sx={{ height: 26 }}
            value={effectiveMode}
          >
            <ToggleButton
              value="tree"
              sx={{ fontSize: 12, px: 1.25, py: 0, textTransform: "none" }}
            >
              {t("inspector.decoded.tree")}
            </ToggleButton>
            <ToggleButton
              value="text"
              sx={{ fontSize: 12, px: 1.25, py: 0, textTransform: "none" }}
            >
              {t("inspector.decoded.text")}
            </ToggleButton>
          </ToggleButtonGroup>
        ) : null}
        <Tooltip arrow title={t("inspector.decoded.decodeAgain")}>
          <span>
            <IconButton
              aria-label={t("inspector.decoded.decodeAgain")}
              disabled={query.isFetching}
              onClick={() => {
                void query.refetch();
              }}
              size="small"
              sx={{ p: 0.5 }}
            >
              {query.isFetching ? (
                <CircularProgress size={16} />
              ) : (
                <RefreshRoundedIcon fontSize="small" />
              )}
            </IconButton>
          </span>
        </Tooltip>
        {entries.length > 0 ? (
          <Button
            aria-expanded={logsOpen}
            onClick={() => setLogsOpen((open) => !open)}
            size="small"
            sx={{ minHeight: 0, px: 0.75, py: 0.25 }}
          >
            {logsOpen
              ? t("inspector.decoded.hideLogs")
              : t("inspector.decoded.showLogs", { count: entries.length })}
          </Button>
        ) : null}
        <Typography
          variant="caption"
          noWrap
          sx={{ color: "text.secondary", flex: 1, minWidth: 0, textAlign: "right" }}
        >
          {[
            ruleName,
            result ? `${result.durationMs} ms` : null,
            decoded ? formatCompactBytes(decoded.sizeBytes) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Typography>
      </Stack>

      {logsOpen && entries.length > 0 ? (
        <Stack spacing={0.75} sx={{ flex: "0 1 auto", maxHeight: "40%", overflow: "auto", pr: 1 }}>
          {entries.map((entry) => (
            <Stack key={entry.sequence} spacing={0.35}>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {entry.kind}
                {entry.level ? ` - ${entry.level}` : ""}
                {entry.key ? ` - ${entry.key}` : ""}
              </Typography>
              {entry.message ? <Typography variant="body2">{entry.message}</Typography> : null}
              {entry.payloadJson ? (
                <TracePayloadBlock
                  originalBytes={entry.payloadOriginalBytes}
                  value={entry.payloadJson}
                />
              ) : null}
            </Stack>
          ))}
        </Stack>
      ) : null}

      <DecodedContent
        currentMatchIndex={currentMatchIndex}
        error={query.error}
        mode={effectiveMode}
        onMatchCountChange={onMatchCountChange}
        onSearchWithText={onSearchWithText}
        result={result}
        ruleName={ruleName}
        searchMatcher={searchMatcher}
        view={view}
      />
    </Stack>
  );
}

function DecodedContent({
  currentMatchIndex,
  error,
  mode,
  onMatchCountChange,
  onSearchWithText,
  result,
  ruleName,
  searchMatcher,
  view,
}: {
  currentMatchIndex: number | undefined;
  error: unknown;
  mode: ViewMode;
  onMatchCountChange: ((count: number) => void) | undefined;
  onSearchWithText: ((text: string) => void) | undefined;
  result: ScriptDecodeResult | null | undefined;
  ruleName: string;
  searchMatcher: SearchMatcher | null;
  view: DecodedBodyView | null;
}) {
  const { t } = useI18n();

  if (error) {
    return (
      <Alert severity="error">
        {t("inspector.decoded.loadFailed", { message: coerceAppError(error).message })}
      </Alert>
    );
  }

  if (!result) {
    return <Alert severity="info">{t("inspector.decoded.noDecoder")}</Alert>;
  }

  if (result.outcome !== "success" && result.outcome !== "skipped") {
    const messages = result.entries
      .filter((entry) => entry.kind === "error" && entry.message)
      .map((entry) => entry.message);
    return (
      <Alert severity="error">
        <Typography variant="body2">
          {t("inspector.decoded.failed", { outcome: result.outcome, rule: ruleName })}
        </Typography>
        {messages.map((message, index) => (
          <Typography key={index} variant="body2" sx={{ fontFamily: fontFamilies.mono, mt: 0.5 }}>
            {message}
          </Typography>
        ))}
      </Alert>
    );
  }

  if (!result.decoded || !view) {
    return <Alert severity="info">{t("inspector.decoded.noResult", { rule: ruleName })}</Alert>;
  }

  return (
    <Stack spacing={1} sx={{ flex: 1, minHeight: 0 }}>
      {result.decoded.truncated ? (
        <Alert severity="warning">
          {t("inspector.decoded.truncated", {
            limit: formatCompactBytes(DECODED_BODY_LIMIT_BYTES),
            size: formatCompactBytes(result.decoded.sizeBytes),
          })}
        </Alert>
      ) : null}
      {view.language === "json" && !view.treeAvailable ? (
        <Alert severity="info">{t("inspector.decoded.treeTooLarge")}</Alert>
      ) : null}
      <Box sx={{ display: "flex", flex: 1, flexDirection: "column", minHeight: 0 }}>
        {mode === "tree" && view.language === "json" ? (
          <SessionInspectorJsonTree
            currentMatchIndex={currentMatchIndex}
            matcher={searchMatcher}
            onMatchCountChange={onMatchCountChange}
            searchQuery=""
            value={view.value}
          />
        ) : (
          <SearchableCodeBlock
            code={view.text}
            currentMatchIndex={currentMatchIndex}
            language={view.language}
            matcher={searchMatcher}
            onMatchCountChange={onMatchCountChange}
            onSearchWithText={onSearchWithText}
            searchQuery=""
          />
        )}
      </Box>
    </Stack>
  );
}
