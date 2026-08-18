import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FormatAlignLeftRoundedIcon from "@mui/icons-material/FormatAlignLeftRounded";
import OpenInFullRoundedIcon from "@mui/icons-material/OpenInFullRounded";
import NavigateBeforeRoundedIcon from "@mui/icons-material/NavigateBeforeRounded";
import NavigateNextRoundedIcon from "@mui/icons-material/NavigateNextRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  Box,
  Button,
  Chip,
  Alert,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  OutlinedInput,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import {
  coerceAppError,
  type BodyReference,
  type BreakpointResolution,
  type HeaderEntry,
} from "@aiproxy/shared-types";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { useStableKeyedRows } from "@/hooks/use-stable-keyed-rows";

import { useI18n } from "@/i18n";
import { resolveBreakpoint } from "@/services/commands";
import { getSyntaxColors } from "@/themes/app-theme";
import { fontFamilies } from "@/themes/fonts";
import { SearchBar } from "@/features/sessions/components/SearchBar";
import {
  INSPECTOR_KEY_VALUE_GRID_TEMPLATE,
  JSON_HIGHLIGHT_CHAR_LIMIT,
  getWorkbenchFontSize,
  renderHighlightedText,
  renderJsonSyntaxHighlightedText,
  inspectorKeyTypographySx,
  inspectorTabsSx,
  inspectorValueTypographySx,
} from "@/features/sessions/components/SessionInspectorShared";
import {
  DEFAULT_REQUEST_SPLIT_RATIO,
  clampInspectorSplitRatio,
  type SearchMatcher,
} from "@/features/sessions/components/session-inspector.helpers";
import { useSearchController } from "@/features/sessions/components/use-search-controller";

import { useBreakpointStore, type PendingBreakpointHit } from "../breakpoint.store";
import { BreakpointCountdownChip } from "./BreakpointCountdownChip";

type BreakpointRequestTab = "query" | "headers" | "body";
type BreakpointResponseTab = "status" | "headers" | "body";
type BodyEditorMode = "form" | "json" | "raw";

// HeaderEditor / UrlEncodedBodyTable render editable name/value tables whose
// public contract is `HeaderEntry[]` (name/value only). The stable-keyed rows
// are provided by the shared `useStableKeyedRows` hook so input focus survives
// local edits (the id is component-local and never leaves via onChange).

function formatCount(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

function buildQueryEntries(path: string): HeaderEntry[] {
  const queryStart = path.indexOf("?");
  if (queryStart < 0 || queryStart === path.length - 1) {
    return [];
  }

  return Array.from(new URLSearchParams(path.slice(queryStart + 1)).entries()).map(
    ([name, value]) => ({
      name,
      value,
    }),
  );
}

function getHeaderValue(headers: HeaderEntry[], name: string) {
  const normalizedName = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === normalizedName)?.value;
}

function getBodyMimeType(body: BodyReference | undefined, headers: HeaderEntry[]) {
  return body?.mimeType ?? getHeaderValue(headers, "content-type") ?? "";
}

function isJsonBody(mimeType: string, text: string) {
  const normalizedMime = mimeType.toLowerCase();
  const trimmedText = text.trim();

  return (
    normalizedMime.includes("application/json") ||
    normalizedMime.includes("+json") ||
    trimmedText.startsWith("{") ||
    trimmedText.startsWith("[")
  );
}

function isUrlEncodedBody(mimeType: string) {
  return mimeType.toLowerCase().includes("application/x-www-form-urlencoded");
}

function getPreferredBodyMode(
  body: BodyReference | undefined,
  headers: HeaderEntry[],
  text: string,
): BodyEditorMode {
  const mimeType = getBodyMimeType(body, headers);

  if (isUrlEncodedBody(mimeType)) {
    return "form";
  }

  if (isJsonBody(mimeType, text)) {
    return "json";
  }

  return "raw";
}

function formatJsonText(text: string) {
  if (!text.trim()) {
    return { ok: true as const, text };
  }

  try {
    return { ok: true as const, text: JSON.stringify(JSON.parse(text), null, 2) };
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : "Invalid JSON",
      text,
    };
  }
}

// Resolve-time JSON guard: returns null when there is nothing to validate
// (body untouched, blank, or not JSON-shaped), otherwise the outcome of a
// strict JSON.parse. The resolve flow uses this to block forwarding broken
// JSON the user just edited — untouched bodies pass through as-is.
function validateJsonText(text: string | null, mimeType: string) {
  if (text === null || !text.trim() || !isJsonBody(mimeType, text)) {
    return null;
  }

  const result = formatJsonText(text);
  if (result.ok) {
    return { ok: true as const };
  }

  return { ok: false as const, message: result.message };
}

function parseUrlEncodedEntries(text: string): HeaderEntry[] {
  try {
    return Array.from(new URLSearchParams(text).entries()).map(([name, value]) => ({
      name,
      value,
    }));
  } catch {
    return [];
  }
}

function encodeUrlEncodedEntries(entries: HeaderEntry[]) {
  const params = new URLSearchParams();

  for (const entry of entries) {
    params.append(entry.name, entry.value);
  }

  return params.toString();
}

function encodeBase64Utf8(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Editable key-value table for headers
// ---------------------------------------------------------------------------

function HeaderEditor({
  addLabel,
  countLabel,
  headers,
  namePlaceholder,
  noHeadersLabel,
  onChange,
  removeLabel,
  title,
  valuePlaceholder,
}: {
  addLabel: string;
  countLabel: string;
  headers: HeaderEntry[];
  namePlaceholder: string;
  noHeadersLabel: string;
  onChange: (headers: HeaderEntry[]) => void;
  removeLabel: string;
  title: string;
  valuePlaceholder: string;
}) {
  const { rows, update, remove, add } = useStableKeyedRows(headers, onChange);
  const headerId = `${title.replace(/\s+/g, "-").toLowerCase()}-title`;

  return (
    <Paper
      aria-labelledby={headerId}
      component="section"
      role="region"
      variant="outlined"
      sx={{ borderRadius: 1, minHeight: 0, overflow: "hidden" }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          px: 1.25,
          py: 0.75,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "action.hover",
        }}
      >
        <Typography id={headerId} sx={{ fontSize: 12, fontWeight: 700 }}>
          {title}
        </Typography>
        <Typography
          sx={{
            color: "text.secondary",
            flex: 1,
            fontSize: 11,
          }}
        >
          {countLabel}
        </Typography>
        <Button size="small" onClick={add} sx={{ fontSize: 12, minHeight: 26, px: 1 }}>
          + {addLabel}
        </Button>
      </Stack>
      <Stack spacing={0.5} sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 0.75 }}>
        {rows.length === 0 ? (
          <Typography
            sx={{
              color: "text.secondary",
              px: 0.5,
              py: 1.25,
              fontSize: 12,
            }}
          >
            {noHeadersLabel}
          </Typography>
        ) : (
          rows.map((h, idx) => (
            <Stack key={h.id} direction="row" spacing={0.5}>
              <OutlinedInput
                size="small"
                placeholder={namePlaceholder}
                value={h.name}
                onChange={(e) => update(idx, "name", e.target.value)}
                sx={{
                  flex: "0 0 34%",
                  fontFamily: fontFamilies.mono,
                  fontSize: 12,
                  "& .MuiOutlinedInput-input": { py: 0.75 },
                }}
              />
              <OutlinedInput
                size="small"
                placeholder={valuePlaceholder}
                value={h.value}
                onChange={(e) => update(idx, "value", e.target.value)}
                sx={{
                  flex: 1,
                  fontFamily: fontFamilies.mono,
                  fontSize: 12,
                  "& .MuiOutlinedInput-input": { py: 0.75 },
                }}
              />
              <IconButton aria-label={removeLabel} size="small" onClick={() => remove(idx)}>
                <CloseRoundedIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Stack>
          ))
        )}
      </Stack>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Body editor
// ---------------------------------------------------------------------------

function BodyEditor({
  body,
  headers,
  metadata,
  label,
  inputAriaLabel,
  readOnly = false,
  regionLabel,
  text,
  onChange,
  onReset,
}: {
  body?: BodyReference | undefined;
  headers: HeaderEntry[];
  metadata: string;
  label: string;
  inputAriaLabel?: string;
  readOnly?: boolean;
  regionLabel: string;
  text: string;
  onChange: (text: string) => void;
  onReset?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const preferredMode = useMemo(
    () => getPreferredBodyMode(body, headers, text),
    [body, headers, text],
  );
  const [mode, setMode] = useState<BodyEditorMode>(preferredMode);
  const [expanded, setExpanded] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [draftText, setDraftText] = useState(() =>
    preferredMode === "json" ? formatJsonText(text).text : text,
  );
  const [formEntries, setFormEntries] = useState<HeaderEntry[]>(() => parseUrlEncodedEntries(text));
  const committedTextRef = useRef(text);
  const searchController = useSearchController();

  useEffect(() => {
    if (text === committedTextRef.current) {
      return;
    }

    committedTextRef.current = text;
    const nextMode = getPreferredBodyMode(body, headers, text);
    setMode(nextMode);
    setDraftText(nextMode === "json" ? formatJsonText(text).text : text);
    setFormEntries(parseUrlEncodedEntries(text));
  }, [body, headers, text]);

  const commitText = useCallback(
    (nextText: string) => {
      committedTextRef.current = nextText;
      setDraftText(nextText);
      onChange(nextText);
    },
    [onChange],
  );

  const updateFormEntries = useCallback(
    (nextEntries: HeaderEntry[]) => {
      const nextText = encodeUrlEncodedEntries(nextEntries);
      committedTextRef.current = nextText;
      setFormEntries(nextEntries);
      onChange(nextText);
    },
    [onChange],
  );

  const handleModeChange = useCallback((nextMode: BodyEditorMode) => {
    // M20: switching modes must NOT silently reformat or drop the user's
    // in-progress text. Previously switching to `json` ran the body through
    // `formatJsonText` (a full re-stringify with no undo), and switching to
    // `form` ran `parseUrlEncodedEntries` — both clobbered byte-exact edits a
    // debugger cares about. Now switching to `json`/`raw` shows the committed
    // text as-is; only the explicit "Format JSON" button reformats. Switching
    // to `form` only happens when the current text actually looks
    // form-encoded (contains `=` or is empty); otherwise we stay in the
    // current text mode so the user's content is preserved verbatim.
    if (nextMode === "form") {
      const current = committedTextRef.current;
      const looksFormEncoded = current.trim() === "" || current.includes("=");
      if (!looksFormEncoded) {
        // Stay in the current mode — do not enter form mode where the text
        // would be silently re-encoded and lose information.
        return;
      }
      setFormEntries(parseUrlEncodedEntries(current));
      setMode("form");
      return;
    }

    setMode(nextMode);
    setDraftText(committedTextRef.current);
  }, []);

  const handleFormatJson = useCallback(() => {
    const formatted = formatJsonText(mode === "form" ? committedTextRef.current : draftText);
    if (formatted.ok) {
      commitText(formatted.text);
      setMode("json");
    }
  }, [commitText, draftText, mode]);

  const handleReset = useCallback(() => {
    committedTextRef.current = text;
    const nextMode = getPreferredBodyMode(body, headers, text);
    setMode(nextMode);
    setDraftText(nextMode === "json" ? formatJsonText(text).text : text);
    setFormEntries(parseUrlEncodedEntries(text));
    onReset?.();
  }, [body, headers, onReset, text]);

  const formText = useMemo(() => encodeUrlEncodedEntries(formEntries), [formEntries]);
  const activeText = mode === "form" ? formText : draftText;
  const canShowForm = preferredMode === "form" || mode === "form";
  const canShowJson =
    preferredMode === "json" ||
    mode === "json" ||
    isJsonBody(getBodyMimeType(body, headers), activeText);
  const jsonResult = mode === "json" ? formatJsonText(draftText) : null;
  const isSearchable = mode !== "form";
  const activeMetadata =
    mode === "form"
      ? formatCount(
          formEntries.length,
          t("breakpointPanel.paramCountOne", { count: formEntries.length }),
          t("breakpointPanel.paramCountMany", { count: formEntries.length }),
        )
      : metadata;

  useEffect(() => {
    if (!isSearchable) {
      setIsSearchOpen(false);
      searchController.onQueryChange("");
    }
  }, [isSearchable, searchController]);

  const editorContent = (
    <BodyEditorContent
      currentMatchIndex={isSearchOpen ? searchController.currentMatchIndex : undefined}
      formEntries={formEntries}
      inputAriaLabel={inputAriaLabel ?? label}
      matcher={isSearchOpen ? searchController.matcher : null}
      mode={mode}
      onMatchCountChange={isSearchOpen ? searchController.setMatchCount : undefined}
      readOnly={readOnly}
      text={activeText}
      onFormEntriesChange={updateFormEntries}
      onTextChange={commitText}
    />
  );

  return (
    <>
      <Paper
        aria-label={regionLabel}
        component="section"
        role="region"
        variant="outlined"
        sx={{
          borderRadius: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          flex: 1,
          height: "100%",
          position: "relative",
        }}
      >
        <BodyEditorToolbar
          activeMetadata={activeMetadata}
          canShowForm={canShowForm}
          canShowJson={canShowJson}
          label={label}
          mode={mode}
          readOnly={readOnly}
          onCopy={() => navigator.clipboard?.writeText(activeText)}
          onExpand={() => setExpanded(true)}
          onFormatJson={handleFormatJson}
          onModeChange={handleModeChange}
          onSearch={isSearchable ? () => setIsSearchOpen((value) => !value) : undefined}
          onReset={onReset ? handleReset : undefined}
          searchActive={isSearchOpen}
        />
        {jsonResult && !jsonResult.ok ? (
          <Typography
            sx={{
              color: "warning.main",
              px: 1.25,
              py: 0.75,
              fontSize: 12,
            }}
          >
            {t("breakpointPanel.invalidJson", { message: jsonResult.message })}
          </Typography>
        ) : null}
        <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden", p: 0.75 }}>{editorContent}</Box>
        {isSearchOpen ? (
          <Box
            sx={{
              maxWidth: "calc(100% - 16px)",
              position: "absolute",
              right: 8,
              top: 42,
              zIndex: 2,
            }}
          >
            <SearchBar
              currentMatchIndex={searchController.currentMatchIndex}
              matchCount={searchController.matchCount}
              onClose={() => {
                setIsSearchOpen(false);
                searchController.onQueryChange("");
              }}
              onNext={searchController.onNext}
              onOptionsChange={searchController.onOptionsChange}
              onPrevious={searchController.onPrevious}
              onQueryChange={searchController.onQueryChange}
              options={searchController.options}
              placeholder={t("inspector.response.jsonTextSearchPlaceholder")}
              query={searchController.query}
              regexInvalid={searchController.isRegexInvalid}
            />
          </Box>
        ) : null}
      </Paper>
      <Dialog
        fullWidth
        maxWidth="lg"
        onClose={() => setExpanded(false)}
        open={expanded}
        slotProps={{
          paper: {
            sx: { height: "min(86vh, 920px)" },
          },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: "center",
            }}
          >
            <Typography component="span" sx={{ fontWeight: 700 }}>
              {label}
            </Typography>
            <Typography
              component="span"
              sx={{
                color: "text.secondary",
                fontSize: 12,
              }}
            >
              {activeMetadata}
            </Typography>
            <Box sx={{ flex: 1 }} />
            {isSearchable ? (
              <Tooltip
                arrow
                title={
                  isSearchOpen
                    ? t("inspector.response.actions.closeSearch")
                    : t("inspector.response.actions.openSearch")
                }
              >
                <IconButton
                  aria-label={
                    isSearchOpen
                      ? t("inspector.response.actions.closeSearch")
                      : t("inspector.response.actions.openSearch")
                  }
                  onClick={() => setIsSearchOpen((value) => !value)}
                  size="small"
                  sx={{ color: isSearchOpen ? "primary.main" : undefined }}
                >
                  <SearchRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : null}
          </Stack>
        </DialogTitle>
        <DialogContent
          dividers
          sx={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            p: 1.5,
            position: "relative",
          }}
        >
          {editorContent}
          {isSearchOpen ? (
            <Box
              sx={{
                maxWidth: "calc(100% - 16px)",
                position: "absolute",
                right: 16,
                top: 16,
                zIndex: 2,
              }}
            >
              <SearchBar
                currentMatchIndex={searchController.currentMatchIndex}
                matchCount={searchController.matchCount}
                onClose={() => {
                  setIsSearchOpen(false);
                  searchController.onQueryChange("");
                }}
                onNext={searchController.onNext}
                onOptionsChange={searchController.onOptionsChange}
                onPrevious={searchController.onPrevious}
                onQueryChange={searchController.onQueryChange}
                options={searchController.options}
                placeholder={t("inspector.response.jsonTextSearchPlaceholder")}
                query={searchController.query}
                regexInvalid={searchController.isRegexInvalid}
              />
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExpanded(false)}>{t("common.actions.cancel")}</Button>
          <Button onClick={() => setExpanded(false)} variant="contained">
            {t("common.actions.apply")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function BodyEditorToolbar({
  activeMetadata,
  canShowForm,
  canShowJson,
  label,
  mode,
  readOnly,
  onCopy,
  onExpand,
  onFormatJson,
  onModeChange,
  onSearch,
  onReset,
  searchActive,
}: {
  activeMetadata: string;
  canShowForm: boolean;
  canShowJson: boolean;
  label: string;
  mode: BodyEditorMode;
  readOnly: boolean;
  onCopy: () => void;
  onExpand: () => void;
  onFormatJson: () => void;
  onModeChange: (mode: BodyEditorMode) => void;
  onSearch?: (() => void) | undefined;
  onReset?: (() => void) | undefined;
  searchActive: boolean;
}) {
  const { t } = useI18n();

  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "center",
        px: 1.25,
        py: 0.75,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "action.hover",
        flexShrink: 0,
      }}
    >
      <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{label}</Typography>
      <Typography
        sx={{
          color: "text.secondary",
          flex: 1,
          fontSize: 11,
        }}
      >
        {activeMetadata}
      </Typography>
      <Stack direction="row" spacing={0.25}>
        {canShowForm ? (
          <Button
            color={mode === "form" ? "primary" : "inherit"}
            onClick={() => onModeChange("form")}
            size="small"
            sx={{ fontSize: 12, minHeight: 26, minWidth: 0, px: 1 }}
          >
            {t("breakpointPanel.formMode")}
          </Button>
        ) : null}
        {canShowJson ? (
          <Button
            color={mode === "json" ? "primary" : "inherit"}
            onClick={() => onModeChange("json")}
            size="small"
            sx={{ fontSize: 12, minHeight: 26, minWidth: 0, px: 1 }}
          >
            {t("breakpointPanel.jsonMode")}
          </Button>
        ) : null}
      </Stack>
      {!readOnly && canShowJson ? (
        <Tooltip arrow title={t("breakpointPanel.formatJson")}>
          <IconButton
            aria-label={t("breakpointPanel.formatJson")}
            onClick={onFormatJson}
            size="small"
          >
            <FormatAlignLeftRoundedIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      ) : null}
      {onSearch ? (
        <Tooltip
          arrow
          title={
            searchActive
              ? t("inspector.response.actions.closeSearch")
              : t("inspector.response.actions.openSearch")
          }
        >
          <IconButton
            aria-label={
              searchActive
                ? t("inspector.response.actions.closeSearch")
                : t("inspector.response.actions.openSearch")
            }
            onClick={onSearch}
            size="small"
            sx={{ color: searchActive ? "primary.main" : undefined }}
          >
            <SearchRoundedIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      ) : null}
      {onReset ? (
        <Tooltip arrow title={t("breakpointPanel.resetBody")}>
          <IconButton aria-label={t("breakpointPanel.resetBody")} onClick={onReset} size="small">
            <RestartAltRoundedIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip arrow title={t("breakpointPanel.copyBody")}>
        <IconButton aria-label={t("breakpointPanel.copyBody")} onClick={onCopy} size="small">
          <ContentCopyRoundedIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
      <Tooltip arrow title={t("breakpointPanel.expandEditor")}>
        <IconButton aria-label={t("breakpointPanel.expandEditor")} onClick={onExpand} size="small">
          <OpenInFullRoundedIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

function BodyEditorContent({
  currentMatchIndex,
  formEntries,
  inputAriaLabel,
  matcher,
  mode,
  onMatchCountChange,
  readOnly,
  text,
  onFormEntriesChange,
  onTextChange,
}: {
  currentMatchIndex?: number | undefined;
  formEntries: HeaderEntry[];
  inputAriaLabel: string;
  matcher?: SearchMatcher | null | undefined;
  mode: BodyEditorMode;
  onMatchCountChange?: ((count: number) => void) | undefined;
  readOnly: boolean;
  text: string;
  onFormEntriesChange: (entries: HeaderEntry[]) => void;
  onTextChange: (text: string) => void;
}) {
  const { t } = useI18n();

  if (mode === "form") {
    return (
      <UrlEncodedBodyTable
        entries={formEntries}
        readOnly={readOnly}
        onChange={onFormEntriesChange}
      />
    );
  }

  return (
    <EditableCodeBlock
      currentMatchIndex={currentMatchIndex}
      inputAriaLabel={inputAriaLabel}
      language={mode === "json" ? "json" : "plain"}
      matcher={matcher}
      onChange={onTextChange}
      onMatchCountChange={onMatchCountChange}
      placeholder={t("breakpointPanel.emptyBody")}
      readOnly={readOnly}
      text={text}
    />
  );
}

const EditableCodeBlock = memo(function EditableCodeBlock({
  currentMatchIndex,
  inputAriaLabel,
  language,
  matcher,
  onChange,
  onMatchCountChange,
  placeholder,
  readOnly,
  text,
}: {
  currentMatchIndex?: number | undefined;
  inputAriaLabel: string;
  language: "json" | "plain";
  matcher?: SearchMatcher | null | undefined;
  onChange: (text: string) => void;
  onMatchCountChange?: ((count: number) => void) | undefined;
  placeholder: string;
  readOnly: boolean;
  text: string;
}) {
  const theme = useTheme();
  const paletteMode = theme.palette.mode;
  const tokenColors = useMemo(() => {
    const colors = getSyntaxColors(paletteMode);
    return { ...colors, punctuation: "text.primary" } as const;
  }, [paletteMode]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const allMatches = useMemo(() => (matcher ? matcher(text) : []), [matcher, text]);
  const currentMatchRange =
    currentMatchIndex === undefined ? null : (allMatches[currentMatchIndex] ?? null);

  useEffect(() => {
    onMatchCountChange?.(allMatches.length);
  }, [allMatches.length, onMatchCountChange]);

  const syncScroll = useCallback(() => {
    if (!textareaRef.current || !preRef.current) {
      return;
    }

    preRef.current.scrollTop = textareaRef.current.scrollTop;
    preRef.current.scrollLeft = textareaRef.current.scrollLeft;
  }, []);

  const shouldJsonHighlight = language === "json" && text.length <= JSON_HIGHLIGHT_CHAR_LIMIT;
  const highlightedText = useMemo(() => {
    if (text.length === 0) return "";
    if (!shouldJsonHighlight)
      return renderHighlightedText(text, undefined, matcher, currentMatchRange);
    return renderJsonSyntaxHighlightedText(
      text,
      tokenColors,
      undefined,
      matcher,
      currentMatchRange,
    );
  }, [text, shouldJsonHighlight, matcher, currentMatchRange, tokenColors]);

  const sharedTextSx = {
    fontFamily: fontFamilies.mono,
    fontSize: (muiTheme: typeof theme) => getWorkbenchFontSize(muiTheme, 12.5),
    lineHeight: 1.55,
    m: 0,
    tabSize: 2,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } as const;

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
        "&:focus-within": {
          borderColor: "primary.main",
          boxShadow: (muiTheme) => `0 0 0 1px ${muiTheme.palette.primary.main}`,
        },
      }}
    >
      <Box
        aria-hidden
        component="pre"
        ref={preRef}
        sx={{
          ...sharedTextSx,
          color: "text.primary",
          inset: 0,
          overflow: "auto",
          p: 1.25,
          pointerEvents: "none",
          position: "absolute",
        }}
      >
        {highlightedText || (
          <Box component="span" sx={{ color: "text.disabled" }}>
            {placeholder}
          </Box>
        )}
      </Box>
      <Box
        aria-label={inputAriaLabel}
        component="textarea"
        readOnly={readOnly}
        ref={textareaRef}
        spellCheck={false}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncScroll}
        sx={{
          ...sharedTextSx,
          bgcolor: "transparent",
          border: 0,
          caretColor: "text.primary",
          color: "transparent",
          height: "100%",
          outline: 0,
          overflow: "auto",
          p: 1.25,
          position: "relative",
          resize: "none",
          width: "100%",
        }}
      />
    </Box>
  );
});

function UrlEncodedBodyTable({
  entries,
  readOnly,
  onChange,
}: {
  entries: HeaderEntry[];
  readOnly: boolean;
  onChange: (entries: HeaderEntry[]) => void;
}) {
  const { t } = useI18n();
  const { rows, update, remove, add } = useStableKeyedRows(entries, onChange);

  return (
    <Stack spacing={0.75} sx={{ height: "100%", minHeight: 0 }}>
      {!readOnly ? (
        <Box>
          <Button onClick={add} size="small" sx={{ fontSize: 12, minHeight: 26, px: 1 }}>
            + {t("breakpointPanel.addParam")}
          </Button>
        </Box>
      ) : null}
      {rows.length === 0 ? (
        <Typography
          sx={{
            color: "text.secondary",
            px: 0.5,
            py: 1.25,
            fontSize: 12,
          }}
        >
          {t("breakpointPanel.noFormParams")}
        </Typography>
      ) : (
        <Stack spacing={0.5} sx={{ minHeight: 0, overflow: "auto" }}>
          <Box
            sx={{
              bgcolor: (theme) =>
                alpha(theme.palette.text.primary, theme.palette.mode === "dark" ? 0.04 : 0.035),
              borderRadius: 1,
              display: "grid",
              gridTemplateColumns: `${INSPECTOR_KEY_VALUE_GRID_TEMPLATE} 32px`,
              minHeight: 24,
            }}
          >
            <Typography sx={{ ...inspectorKeyTypographySx, px: 0.75, py: 0.5, fontWeight: 500 }}>
              {t("common.placeholders.name")}
            </Typography>
            <Typography sx={{ ...inspectorKeyTypographySx, px: 0.75, py: 0.5, fontWeight: 500 }}>
              {t("common.placeholders.value")}
            </Typography>
            <Box />
          </Box>
          {rows.map((entry, index) => (
            <Box
              key={entry.id}
              sx={{
                alignItems: "start",
                display: "grid",
                gap: 0.5,
                gridTemplateColumns: `${INSPECTOR_KEY_VALUE_GRID_TEMPLATE} 32px`,
                minHeight: 40,
              }}
            >
              <OutlinedInput
                inputProps={{ readOnly, title: entry.name }}
                placeholder={t("common.placeholders.name")}
                size="small"
                value={entry.name}
                onChange={(event) => update(index, "name", event.target.value)}
                sx={{
                  ...inspectorValueTypographySx,
                  fontFamily: fontFamilies.mono,
                  width: "100%",
                  "& .MuiOutlinedInput-input": {
                    overflow: "hidden",
                    py: 0.75,
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                }}
              />
              <OutlinedInput
                inputProps={{ readOnly, title: entry.value }}
                placeholder={t("common.placeholders.value")}
                size="small"
                value={entry.value}
                onChange={(event) => update(index, "value", event.target.value)}
                sx={{
                  ...inspectorValueTypographySx,
                  fontFamily: fontFamilies.mono,
                  minWidth: 0,
                  width: "100%",
                  "& .MuiOutlinedInput-input": {
                    overflow: "hidden",
                    py: 0.75,
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                }}
              />
              {!readOnly ? (
                <IconButton
                  aria-label={t("breakpointPanel.removeParam")}
                  onClick={() => remove(index)}
                  size="small"
                >
                  <CloseRoundedIcon sx={{ fontSize: 16 }} />
                </IconButton>
              ) : (
                <Box />
              )}
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Method badge color helper
// ---------------------------------------------------------------------------

function methodColor(
  method: string,
): "default" | "primary" | "success" | "warning" | "error" | "info" | "secondary" {
  switch (method.toUpperCase()) {
    case "GET":
      return "success";
    case "POST":
      return "primary";
    case "PUT":
      return "warning";
    case "PATCH":
      return "info";
    case "DELETE":
      return "error";
    default:
      return "default";
  }
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function BreakpointInterceptPanel() {
  const { t } = useI18n();
  const pendingHits = useBreakpointStore((s) => s.pendingHits);
  const activeHitId = useBreakpointStore((s) => s.activeHitId);
  const setActiveHitId = useBreakpointStore((s) => s.setActiveHitId);
  const removePendingHit = useBreakpointStore((s) => s.removePendingHit);

  const [requestTab, setRequestTab] = useState<BreakpointRequestTab>("query");
  const [responseTab, setResponseTab] = useState<BreakpointResponseTab>("status");
  const [requestCollapsed, setRequestCollapsed] = useState(false);
  const [splitRatio, setSplitRatio] = useState(DEFAULT_REQUEST_SPLIT_RATIO);
  // M21: tracks the active resize cleanup fn so a mid-drag unmount (e.g. the
  // breakpoint resolves or another hit replaces this panel) can remove the
  // window pointer listeners instead of leaking them until some unrelated
  // pointerup elsewhere finally fires.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [mockStatusCode, setMockStatusCode] = useState("200");
  const [mockHeaders, setMockHeaders] = useState<HeaderEntry[]>([
    { name: "content-type", value: "application/json" },
  ]);
  const [mockBody, setMockBody] = useState('{\n  "message": "mocked"\n}');

  // Editable copies
  const [editedReqQueryParams, setEditedReqQueryParams] = useState<HeaderEntry[] | null>(null);
  const [editedReqHeaders, setEditedReqHeaders] = useState<HeaderEntry[] | null>(null);
  const [editedReqBody, setEditedReqBody] = useState<string | null>(null);
  const [editedRespStatusCode, setEditedRespStatusCode] = useState<string | null>(null);
  const [editedRespHeaders, setEditedRespHeaders] = useState<HeaderEntry[] | null>(null);
  const [editedRespBody, setEditedRespBody] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolvingAction, setResolvingAction] = useState<BreakpointResolution["action"] | null>(
    null,
  );

  const activeHit: PendingBreakpointHit | undefined = useMemo(
    () => pendingHits.find((h) => h.sessionId === activeHitId),
    [pendingHits, activeHitId],
  );

  const activeIdx = pendingHits.findIndex((h) => h.sessionId === activeHitId);
  const totalCount = pendingHits.length;

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = event.currentTarget.parentElement;

      if (!container || requestCollapsed) {
        return;
      }

      event.preventDefault();
      const pointerId = event.pointerId;
      event.currentTarget.setPointerCapture(pointerId);

      const updateRatio = (clientY: number) => {
        const bounds = container.getBoundingClientRect();

        if (bounds.height <= 0) {
          return;
        }

        setSplitRatio(clampInspectorSplitRatio((clientY - bounds.top) / bounds.height));
      };

      updateRatio(event.clientY);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        updateRatio(moveEvent.clientY);
      };

      // M21: store the cleanup on the ref so the unmount effect can run it if
      // the panel is torn down mid-drag. Release the pointer capture so the
      // element does not keep capturing pointer events after the drag ends.
      const target = event.currentTarget;
      const stopResize = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          // releasePointerCapture throws if the capture was already released
          // (e.g. the browser implicitly released on pointerup). Swallow — the
          // capture is gone either way.
        }
        if (resizeCleanupRef.current === stopResize) {
          resizeCleanupRef.current = null;
        }
      };
      resizeCleanupRef.current = stopResize;

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
    [requestCollapsed],
  );

  // M21: if the panel unmounts while a resize drag is in flight (breakpoint
  // resolved, replaced by another hit, navigation away), the window pointer
  // listeners would leak until an unrelated pointerup fired. Run the active
  // cleanup on unmount.
  useEffect(() => {
    return () => {
      const cleanup = resizeCleanupRef.current;
      if (cleanup) cleanup();
      resizeCleanupRef.current = null;
    };
  }, []);

  const navigateHit = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(totalCount - 1, activeIdx + delta));
      const nextHit = pendingHits[next];
      if (nextHit) {
        setActiveHitId(nextHit.sessionId);
        setMockMode(false);
        setEditedReqQueryParams(null);
        setEditedReqHeaders(null);
        setEditedReqBody(null);
        setEditedRespStatusCode(null);
        setEditedRespHeaders(null);
        setEditedRespBody(null);
        setResolveError(null);
        setResolvingAction(null);
        setRequestTab("query");
        setResponseTab("status");
      }
    },
    [activeIdx, totalCount, pendingHits, setActiveHitId],
  );

  const handleResolve = useCallback(
    async (action: BreakpointResolution["action"]) => {
      if (!activeHit || resolvingAction) return;

      setResolveError(null);

      // Validate the status code inputs before building the resolution. The old
      // `Number(x) || 200` silently swallowed empty/NaN and submitted a 200 the
      // user never typed. Now an invalid code blocks submit and surfaces an
      // error so the user knows why nothing was sent.
      if (action === "mock") {
        const parsedMock = Number(mockStatusCode);
        if (mockStatusCode.trim() === "" || !Number.isFinite(parsedMock)) {
          setResolveError(t("breakpointPanel.invalidStatusCode"));
          return;
        }
      }
      if (action !== "drop" && editedRespStatusCode !== null) {
        const parsedResp = Number(editedRespStatusCode);
        if (editedRespStatusCode.trim() === "" || !Number.isFinite(parsedResp)) {
          setResolveError(t("breakpointPanel.invalidStatusCode"));
          return;
        }
      }

      // Block broken JSON only when the edited body will actually be sent
      // back. Drop does not transmit any body, so it should never be blocked
      // by a malformed draft.
      if (action !== "drop") {
        const jsonChecks = [
          validateJsonText(
            editedReqBody,
            getBodyMimeType(activeHit.requestBody, editedReqHeaders ?? activeHit.requestHeaders),
          ),
          validateJsonText(
            editedRespBody,
            getBodyMimeType(
              activeHit.responseBody,
              editedRespHeaders ?? activeHit.responseHeaders ?? [],
            ),
          ),
          ...(action === "mock"
            ? [validateJsonText(mockBody, getBodyMimeType(undefined, mockHeaders))]
            : []),
        ];
        const brokenJson = jsonChecks.find(
          (result): result is { ok: false; message: string } => result !== null && !result.ok,
        );
        if (brokenJson) {
          setResolveError(t("breakpointPanel.invalidJson", { message: brokenJson.message }));
          return;
        }
      }

      setResolvingAction(action);

      const resolution: BreakpointResolution =
        action === "drop"
          ? {
              sessionId: activeHit.sessionId,
              action,
            }
          : {
              sessionId: activeHit.sessionId,
              action,
              ...(action === "mock"
                ? {
                    mock: {
                      statusCode: Number(mockStatusCode),
                      headers: mockHeaders,
                      bodyBase64: encodeBase64Utf8(mockBody),
                    },
                  }
                : {}),
              ...(editedReqHeaders ? { modifiedRequestHeaders: editedReqHeaders } : {}),
              ...(editedReqQueryParams ? { modifiedRequestQueryParams: editedReqQueryParams } : {}),
              ...(editedReqBody !== null
                ? { modifiedRequestBodyBase64: encodeBase64Utf8(editedReqBody) }
                : {}),
              ...(editedRespStatusCode !== null
                ? { modifiedResponseStatusCode: Number(editedRespStatusCode) }
                : {}),
              ...(editedRespHeaders ? { modifiedResponseHeaders: editedRespHeaders } : {}),
              ...(editedRespBody !== null
                ? { modifiedResponseBodyBase64: encodeBase64Utf8(editedRespBody) }
                : {}),
            };

      const resetDrafts = () => {
        setMockMode(false);
        setEditedReqQueryParams(null);
        setEditedReqHeaders(null);
        setEditedReqBody(null);
        setEditedRespStatusCode(null);
        setEditedRespHeaders(null);
        setEditedRespBody(null);
        setRequestTab("query");
        setResponseTab("status");
      };

      try {
        await resolveBreakpoint(resolution);
        removePendingHit(activeHit.sessionId);
        resetDrafts();
      } catch (error) {
        const message = coerceAppError(error).message;

        if (message.toLowerCase().includes("no pending breakpoint")) {
          removePendingHit(activeHit.sessionId);
          resetDrafts();
        } else {
          setResolveError(message);
        }
      } finally {
        setResolvingAction(null);
      }
    },
    [
      activeHit,
      resolvingAction,
      mockStatusCode,
      mockHeaders,
      mockBody,
      editedReqQueryParams,
      editedReqHeaders,
      editedReqBody,
      editedRespStatusCode,
      editedRespHeaders,
      editedRespBody,
      removePendingHit,
      t,
    ],
  );

  if (!activeHit || totalCount === 0) return null;

  const reqHeaders = editedReqHeaders ?? activeHit.requestHeaders;
  const reqQueryParams = editedReqQueryParams ?? buildQueryEntries(activeHit.path);
  const reqBody = editedReqBody ?? activeHit.requestBody?.inlineText ?? "";
  const respStatusCode = editedRespStatusCode ?? String(activeHit.responseStatusCode ?? 200);
  const respHeaders = editedRespHeaders ?? activeHit.responseHeaders ?? [];
  const respBody = editedRespBody ?? activeHit.responseBody?.inlineText ?? "";
  const isRequestStage = activeHit.stage === "request";
  const requestHeaderCount = formatCount(
    reqHeaders.length,
    t("breakpointPanel.headerCountOne", { count: reqHeaders.length }),
    t("breakpointPanel.headerCountMany", { count: reqHeaders.length }),
  );
  const queryCount = formatCount(
    reqQueryParams.length,
    t("breakpointPanel.queryCountOne", { count: reqQueryParams.length }),
    t("breakpointPanel.queryCountMany", { count: reqQueryParams.length }),
  );
  const responseHeaderCount = formatCount(
    respHeaders.length,
    t("breakpointPanel.headerCountOne", { count: respHeaders.length }),
    t("breakpointPanel.headerCountMany", { count: respHeaders.length }),
  );
  const mockHeaderCount = formatCount(
    mockHeaders.length,
    t("breakpointPanel.headerCountOne", { count: mockHeaders.length }),
    t("breakpointPanel.headerCountMany", { count: mockHeaders.length }),
  );
  const requestBodyMeta =
    reqBody.length === 0
      ? t("breakpointPanel.emptyBody")
      : formatCount(
          reqBody.length,
          t("breakpointPanel.characterCountOne", { count: reqBody.length }),
          t("breakpointPanel.characterCountMany", { count: reqBody.length }),
        );
  const responseBodyMeta =
    respBody.length === 0
      ? t("breakpointPanel.emptyBody")
      : formatCount(
          respBody.length,
          t("breakpointPanel.characterCountOne", { count: respBody.length }),
          t("breakpointPanel.characterCountMany", { count: respBody.length }),
        );
  const mockBodyMeta =
    mockBody.length === 0
      ? t("breakpointPanel.emptyBody")
      : formatCount(
          mockBody.length,
          t("breakpointPanel.characterCountOne", { count: mockBody.length }),
          t("breakpointPanel.characterCountMany", { count: mockBody.length }),
        );
  const responseTabsDisabled = isRequestStage && !mockMode;

  // Request pane tab labels
  const requestTabLabels = {
    query: t("breakpointPanel.query"),
    headers: t("breakpointPanel.headers"),
    body: t("breakpointPanel.body"),
  };

  // Response pane tab labels
  const responseTabLabels = {
    status: t("breakpointPanel.statusLabel"),
    headers: t("breakpointPanel.headers"),
    body: t("breakpointPanel.body"),
  };

  return (
    <Paper
      elevation={8}
      sx={{
        borderLeft: 2,
        borderColor: "warning.main",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Top summary bar */}
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          px: 2,
          py: 0.75,
          borderBottom: 1,
          borderColor: "divider",
          minWidth: 0,
          flexShrink: 0,
        }}
      >
        <Chip
          label={activeHit.method}
          size="small"
          color={methodColor(activeHit.method)}
          sx={{ fontWeight: 700, fontFamily: fontFamilies.mono, fontSize: 11 }}
        />
        <BreakpointCountdownChip receivedAt={activeHit.receivedAt} />
        {mockMode && (
          <Chip
            label={t("breakpointPanel.mockMode")}
            size="small"
            color="warning"
            variant="outlined"
            sx={{ fontSize: 11 }}
          />
        )}
        <Stack direction="row" spacing={1} sx={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <Typography
            noWrap
            sx={{
              flex: "0 0 auto",
              fontFamily: fontFamilies.mono,
              fontSize: 12,
              fontWeight: 700,
              maxWidth: "30%",
            }}
          >
            {activeHit.host}
          </Typography>
          <Typography
            noWrap
            sx={{
              flex: 1,
              fontFamily: fontFamilies.mono,
              fontSize: 12,
              color: "text.secondary",
              minWidth: 0,
            }}
          >
            {activeHit.path}
          </Typography>
        </Stack>

        <Stack
          direction="row"
          spacing={0.25}
          sx={{
            alignItems: "center",
          }}
        >
          <IconButton size="small" disabled={activeIdx <= 0} onClick={() => navigateHit(-1)}>
            <NavigateBeforeRoundedIcon fontSize="small" />
          </IconButton>
          <Typography sx={{ fontSize: 12, whiteSpace: "nowrap" }}>
            {activeIdx + 1} / {totalCount}
          </Typography>
          <IconButton
            size="small"
            disabled={activeIdx >= totalCount - 1}
            onClick={() => navigateHit(1)}
          >
            <NavigateNextRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>
      {/* 2-pane grid: Request (top) + Response (bottom) */}
      <Box
        sx={{
          display: "grid",
          flex: 1,
          gridTemplateRows: requestCollapsed
            ? "auto 1px minmax(0, 1fr)"
            : `${splitRatio}fr 1px ${1 - splitRatio}fr`,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {/* Request Pane */}
        <Box
          sx={{
            minHeight: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Box
            sx={(theme) => ({
              alignItems: "center",
              bgcolor: alpha(
                theme.palette.background.paper,
                theme.palette.mode === "dark" ? 0.72 : 0.86,
              ),
              display: "flex",
              minHeight: 36,
              pr: 0.75,
              borderBottom: 1,
              borderColor: "divider",
            })}
          >
            <Tabs
              value={requestTab}
              onChange={(_, v) => setRequestTab(v as BreakpointRequestTab)}
              variant="scrollable"
              scrollButtons="auto"
              sx={inspectorTabsSx}
            >
              <Tab value="query" label={requestTabLabels.query} />
              <Tab value="headers" label={requestTabLabels.headers} />
              <Tab value="body" label={requestTabLabels.body} />
            </Tabs>
            <Button
              onClick={() => setRequestCollapsed((collapsed) => !collapsed)}
              size="small"
              startIcon={requestCollapsed ? <ExpandMoreRoundedIcon /> : <ExpandLessRoundedIcon />}
              sx={{
                color: "primary.main",
                fontSize: 12,
                fontWeight: 500,
                minHeight: 30,
                minWidth: 0,
                px: 1.25,
                "& .MuiButton-startIcon": {
                  mr: 0.5,
                  "& > *:nth-of-type(1)": {
                    fontSize: 18,
                  },
                },
              }}
              variant="text"
            >
              {requestCollapsed ? t("common.actions.expand") : t("common.actions.collapse")}
            </Button>
          </Box>

          {requestCollapsed ? null : (
            <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
              {requestTab === "query" && (
                <Box aria-label={t("breakpointPanel.query")} role="tabpanel">
                  <HeaderEditor
                    addLabel={t("breakpointPanel.addQuery")}
                    countLabel={queryCount}
                    headers={reqQueryParams}
                    namePlaceholder={t("common.placeholders.name")}
                    noHeadersLabel={t("breakpointPanel.noQueryParams")}
                    onChange={(h) => setEditedReqQueryParams(h)}
                    removeLabel={t("breakpointPanel.removeQuery")}
                    title={t("breakpointPanel.query")}
                    valuePlaceholder={t("common.placeholders.value")}
                  />
                </Box>
              )}
              {requestTab === "headers" && (
                <Box aria-label={t("breakpointPanel.headers")} role="tabpanel">
                  <HeaderEditor
                    addLabel={t("common.actions.addHeader")}
                    countLabel={requestHeaderCount}
                    headers={reqHeaders}
                    namePlaceholder={t("common.placeholders.name")}
                    noHeadersLabel={t("breakpointPanel.noHeaders")}
                    onChange={(h) => setEditedReqHeaders(h)}
                    removeLabel={t("breakpointPanel.removeHeader")}
                    title={t("breakpointPanel.headers")}
                    valuePlaceholder={t("common.placeholders.value")}
                  />
                </Box>
              )}
              {requestTab === "body" && (
                <Box role="tabpanel" sx={{ height: "100%" }}>
                  <BodyEditor
                    body={activeHit.requestBody}
                    headers={reqHeaders}
                    metadata={requestBodyMeta}
                    label={t("breakpointPanel.body")}
                    regionLabel={t("breakpointPanel.body")}
                    text={reqBody}
                    onChange={(t) => setEditedReqBody(t)}
                    onReset={() => setEditedReqBody(null)}
                  />
                </Box>
              )}
            </Box>
          )}
        </Box>

        {/* Horizontal splitter */}
        {requestCollapsed ? (
          <Divider />
        ) : (
          <Box
            aria-hidden
            data-testid="breakpoint-splitter"
            onPointerDown={startResize}
            sx={{
              alignItems: "center",
              cursor: "row-resize",
              display: "flex",
              justifyContent: "center",
              minHeight: 0,
              position: "relative",
              touchAction: "none",
              userSelect: "none",
              "&::before": {
                bgcolor: (theme) =>
                  alpha(theme.palette.divider, theme.palette.mode === "dark" ? 0.76 : 1),
                content: '""',
                height: 1,
                opacity: 1,
                transition: "background-color 120ms ease, opacity 120ms ease",
                width: "100%",
              },
              "&::after": {
                content: '""',
                inset: "-3px 0",
                position: "absolute",
              },
              "&:hover::before": {
                bgcolor: "primary.main",
                opacity: 1,
              },
            }}
          />
        )}

        {/* Response Pane */}
        <Box
          data-testid="breakpoint-response-pane"
          sx={{
            minHeight: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            ...(responseTabsDisabled
              ? {
                  opacity: 0.5,
                  pointerEvents: "none",
                }
              : {}),
          }}
        >
          <Box
            sx={(theme) => ({
              alignItems: "center",
              bgcolor: alpha(
                theme.palette.background.paper,
                theme.palette.mode === "dark" ? 0.72 : 0.86,
              ),
              display: "flex",
              minHeight: 36,
              pr: 0.75,
              borderBottom: 1,
              borderColor: "divider",
            })}
          >
            <Tabs
              value={responseTab}
              onChange={(_, v) => setResponseTab(v as BreakpointResponseTab)}
              variant="scrollable"
              scrollButtons="auto"
              sx={inspectorTabsSx}
            >
              <Tab
                value="status"
                label={responseTabLabels.status}
                icon={<RuleRoundedIcon />}
                iconPosition="start"
                disabled={responseTabsDisabled}
              />
              <Tab
                value="headers"
                label={responseTabLabels.headers}
                disabled={responseTabsDisabled}
              />
              <Tab value="body" label={responseTabLabels.body} disabled={responseTabsDisabled} />
            </Tabs>
          </Box>

          <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
            {responseTab === "status" && (
              <Box role="tabpanel">
                <Paper variant="outlined" sx={{ borderRadius: 1, overflow: "hidden" }}>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{
                      alignItems: "center",
                      px: 1.25,
                      py: 0.75,
                      borderBottom: 1,
                      borderColor: "divider",
                      bgcolor: "action.hover",
                    }}
                  >
                    <Typography sx={{ fontSize: 12, fontWeight: 700 }}>
                      {t("breakpointPanel.statusLabel")}
                    </Typography>
                  </Stack>
                  <Box sx={{ p: 1.25 }}>
                    <OutlinedInput
                      inputProps={{
                        "aria-label": t("breakpointPanel.statusLabel"),
                        min: 100,
                        max: 599,
                      }}
                      size="small"
                      type="number"
                      value={mockMode ? mockStatusCode : respStatusCode}
                      onChange={(e) =>
                        mockMode
                          ? setMockStatusCode(e.target.value)
                          : setEditedRespStatusCode(e.target.value)
                      }
                      sx={{ width: 112, fontFamily: fontFamilies.mono, fontSize: 12 }}
                    />
                  </Box>
                </Paper>
              </Box>
            )}
            {responseTab === "headers" && (
              <Box aria-label={t("breakpointPanel.headers")} role="tabpanel">
                <HeaderEditor
                  addLabel={t("common.actions.addHeader")}
                  countLabel={mockMode ? mockHeaderCount : responseHeaderCount}
                  headers={mockMode ? mockHeaders : respHeaders}
                  namePlaceholder={t("common.placeholders.name")}
                  noHeadersLabel={t("breakpointPanel.noHeaders")}
                  onChange={mockMode ? setMockHeaders : (h) => setEditedRespHeaders(h)}
                  removeLabel={t("breakpointPanel.removeHeader")}
                  title={t("breakpointPanel.headers")}
                  valuePlaceholder={t("common.placeholders.value")}
                />
              </Box>
            )}
            {responseTab === "body" && (
              <Box role="tabpanel" sx={{ height: "100%" }}>
                <BodyEditor
                  body={mockMode ? undefined : activeHit.responseBody}
                  headers={mockMode ? mockHeaders : respHeaders}
                  metadata={mockMode ? mockBodyMeta : responseBodyMeta}
                  label={t("breakpointPanel.body")}
                  regionLabel={t("breakpointPanel.body")}
                  text={mockMode ? mockBody : respBody}
                  onChange={mockMode ? setMockBody : (t) => setEditedRespBody(t)}
                  onReset={mockMode ? undefined : () => setEditedRespBody(null)}
                />
              </Box>
            )}
          </Box>
        </Box>
      </Box>
      <Divider />
      {/* Bottom action bar */}
      <Stack
        direction="row"
        spacing={1}
        sx={{
          px: 2,
          py: 1,
          alignItems: "center",
          justifyContent: "space-between",
          bgcolor: "action.hover",
          flexShrink: 0,
        }}
      >
        <Box>
          {isRequestStage && !mockMode && (
            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={() => {
                setMockMode(true);
                setResponseTab("body");
              }}
              sx={{ fontSize: 12 }}
            >
              {t("common.actions.mockResponse")}
            </Button>
          )}
          {mockMode && (
            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={() => setMockMode(false)}
              sx={{ fontSize: 12 }}
            >
              {t("breakpointPanel.cancelMock")}
            </Button>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={<DeleteRoundedIcon />}
            disabled={resolvingAction !== null}
            onClick={() => handleResolve("drop")}
            sx={{ fontSize: 12 }}
          >
            {resolvingAction === "drop"
              ? t("breakpointPanel.resolving")
              : t("breakpointPanel.drop")}
          </Button>
          <Button
            size="small"
            variant="contained"
            color="success"
            startIcon={<CheckCircleRoundedIcon />}
            disabled={resolvingAction !== null}
            onClick={() => handleResolve(mockMode ? "mock" : "forward")}
            sx={{ fontSize: 12 }}
          >
            {resolvingAction === "forward" || resolvingAction === "mock"
              ? t("breakpointPanel.resolving")
              : mockMode
                ? t("common.actions.sendMock")
                : t("common.actions.forward")}
          </Button>
        </Stack>
      </Stack>
      <Snackbar
        autoHideDuration={5000}
        onClose={() => setResolveError(null)}
        open={Boolean(resolveError)}
      >
        <Alert
          onClose={() => setResolveError(null)}
          severity="error"
          sx={{ maxWidth: 720 }}
          variant="filled"
        >
          {resolveError}
        </Alert>
      </Snackbar>
    </Paper>
  );
}
