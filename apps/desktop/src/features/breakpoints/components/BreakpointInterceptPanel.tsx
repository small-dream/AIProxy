import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import CodeRoundedIcon from "@mui/icons-material/CodeRounded";
import DeleteRoundedIcon from "@mui/icons-material/DeleteRounded";
import NavigateBeforeRoundedIcon from "@mui/icons-material/NavigateBeforeRounded";
import NavigateNextRoundedIcon from "@mui/icons-material/NavigateNextRounded";
import RuleRoundedIcon from "@mui/icons-material/RuleRounded";
import { Box, Button, Chip, Divider, IconButton, OutlinedInput, Paper, Stack, Tab, Tabs, Typography } from "@mui/material";
import type { BreakpointHit, BreakpointResolution, HeaderEntry } from "@aiproxy/shared-types";
import { useCallback, useMemo, useState } from "react";

import { useI18n } from "@/i18n";
import { resolveBreakpoint } from "@/services/commands";
import { fontFamilies } from "@/themes/fonts";

import { useBreakpointStore } from "../breakpoint.store";

// ---------------------------------------------------------------------------
// Editable key-value table for headers
// ---------------------------------------------------------------------------

function HeaderEditor({
  addLabel,
  headers,
  namePlaceholder,
  onChange,
  valuePlaceholder,
}: {
  addLabel: string;
  headers: HeaderEntry[];
  namePlaceholder: string;
  onChange: (headers: HeaderEntry[]) => void;
  valuePlaceholder: string;
}) {
  const add = () => onChange([...headers, { name: "", value: "" }]);
  const remove = (idx: number) => onChange(headers.filter((_, i) => i !== idx));
  const update = (idx: number, field: "name" | "value", val: string) =>
    onChange(headers.map((h, i) => (i === idx ? { ...h, [field]: val } : h)));

  return (
    <Stack spacing={0.5}>
      {headers.map((h, idx) => (
        <Stack key={idx} direction="row" spacing={0.5}>
          <OutlinedInput
            size="small"
            placeholder={namePlaceholder}
            value={h.name}
            onChange={(e) => update(idx, "name", e.target.value)}
            sx={{ flex: 1, fontFamily: fontFamilies.mono, fontSize: 12 }}
          />
          <OutlinedInput
            size="small"
            placeholder={valuePlaceholder}
            value={h.value}
            onChange={(e) => update(idx, "value", e.target.value)}
            sx={{ flex: 1.5, fontFamily: fontFamilies.mono, fontSize: 12 }}
          />
          <IconButton size="small" onClick={() => remove(idx)}>
            <CloseRoundedIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Stack>
      ))}
      <Button size="small" onClick={add} sx={{ alignSelf: "flex-start", fontSize: 12 }}>
        + {addLabel}
      </Button>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Body editor
// ---------------------------------------------------------------------------

function BodyEditor({
  label,
  text,
  onChange,
}: {
  label: string;
  text: string;
  onChange: (text: string) => void;
}) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <OutlinedInput
        multiline
        minRows={3}
        maxRows={8}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        sx={{
          fontFamily: fontFamilies.mono,
          fontSize: 12,
          resize: "vertical",
        }}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Method badge color helper
// ---------------------------------------------------------------------------

function methodColor(method: string): "default" | "primary" | "success" | "warning" | "error" | "info" | "secondary" {
  switch (method.toUpperCase()) {
    case "GET": return "success";
    case "POST": return "primary";
    case "PUT": return "warning";
    case "PATCH": return "info";
    case "DELETE": return "error";
    default: return "default";
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

  const [tab, setTab] = useState(0);
  const [mockMode, setMockMode] = useState(false);
  const [mockStatusCode, setMockStatusCode] = useState("200");
  const [mockHeaders, setMockHeaders] = useState<HeaderEntry[]>([
    { name: "content-type", value: "application/json" },
  ]);
  const [mockBody, setMockBody] = useState('{\n  "message": "mocked"\n}');

  // Editable copies
  const [editedReqHeaders, setEditedReqHeaders] = useState<HeaderEntry[] | null>(null);
  const [editedReqBody, setEditedReqBody] = useState<string | null>(null);
  const [editedRespHeaders, setEditedRespHeaders] = useState<HeaderEntry[] | null>(null);
  const [editedRespBody, setEditedRespBody] = useState<string | null>(null);

  const activeHit: BreakpointHit | undefined = useMemo(
    () => pendingHits.find((h) => h.sessionId === activeHitId),
    [pendingHits, activeHitId],
  );

  const activeIdx = pendingHits.findIndex((h) => h.sessionId === activeHitId);
  const totalCount = pendingHits.length;

  const navigateHit = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(totalCount - 1, activeIdx + delta));
      const nextHit = pendingHits[next];
      if (nextHit) {
        setActiveHitId(nextHit.sessionId);
        setMockMode(false);
      }
    },
    [activeIdx, totalCount, pendingHits, setActiveHitId],
  );

  const handleResolve = useCallback(
    async (action: BreakpointResolution["action"]) => {
      if (!activeHit) return;

      const resolution: BreakpointResolution = {
        sessionId: activeHit.sessionId,
        action,
        ...(action === "mock"
          ? {
              mock: {
                statusCode: Number(mockStatusCode) || 200,
                headers: mockHeaders,
                bodyBase64: btoa(mockBody),
              },
            }
          : {}),
        ...(editedReqHeaders ? { modifiedRequestHeaders: editedReqHeaders } : {}),
        ...(editedReqBody !== null ? { modifiedRequestBodyBase64: btoa(editedReqBody) } : {}),
        ...(editedRespHeaders ? { modifiedResponseHeaders: editedRespHeaders } : {}),
        ...(editedRespBody !== null ? { modifiedResponseBodyBase64: btoa(editedRespBody) } : {}),
      };

      try {
        await resolveBreakpoint(resolution);
        removePendingHit(activeHit.sessionId);
        setMockMode(false);
        // Reset edits
        setEditedReqHeaders(null);
        setEditedReqBody(null);
        setEditedRespHeaders(null);
        setEditedRespBody(null);
      } catch {
        // Error already reported by the command layer
      }
    },
    [activeHit, mockStatusCode, mockHeaders, mockBody, editedReqHeaders, editedReqBody, editedRespHeaders, editedRespBody, removePendingHit],
  );

  if (!activeHit || totalCount === 0) return null;

  const reqHeaders = editedReqHeaders ?? activeHit.requestHeaders;
  const reqBody = editedReqBody ?? activeHit.requestBody?.inlineText ?? "";
  const respHeaders = editedRespHeaders ?? activeHit.responseHeaders ?? [];
  const respBody = editedRespBody ?? activeHit.responseBody?.inlineText ?? "";
  const isRequestStage = activeHit.stage === "request";

  return (
    <Paper
      elevation={8}
      sx={{
        borderTop: 2,
        borderColor: "warning.main",
        display: "flex",
        flexDirection: "column",
        maxHeight: "55vh",
        flexShrink: 0,
      }}
    >
      {/* Top bar */}
      <Stack
        alignItems="center"
        direction="row"
        spacing={1}
        sx={{ px: 2, py: 0.75, borderBottom: 1, borderColor: "divider" }}
      >
        <Chip
          label={activeHit.method}
          size="small"
          color={methodColor(activeHit.method)}
          sx={{ fontWeight: 700, fontFamily: fontFamilies.mono, fontSize: 11 }}
        />
        <Chip
          label={isRequestStage ? t("breakpointPanel.requestTab") : t("breakpointPanel.responseTab")}
          size="small"
          variant="outlined"
          color={isRequestStage ? "info" : "secondary"}
          sx={{ fontSize: 11 }}
        />
        <Typography
          noWrap
          sx={{
            flex: 1,
            fontFamily: fontFamilies.mono,
            fontSize: 12,
            color: "text.secondary",
          }}
        >
          {activeHit.host}{activeHit.path}
        </Typography>

        {/* Navigation */}
        <Stack alignItems="center" direction="row" spacing={0.25}>
          <IconButton size="small" disabled={activeIdx <= 0} onClick={() => navigateHit(-1)}>
            <NavigateBeforeRoundedIcon fontSize="small" />
          </IconButton>
          <Typography sx={{ fontSize: 12, whiteSpace: "nowrap" }}>
            {activeIdx + 1} / {totalCount}
          </Typography>
          <IconButton size="small" disabled={activeIdx >= totalCount - 1} onClick={() => navigateHit(1)}>
            <NavigateNextRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>

      {/* Tabs + content */}
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ minHeight: 36, borderBottom: 1, borderColor: "divider", px: 1 }}
      >
        <Tab label={t("breakpointPanel.requestTab")} icon={<CodeRoundedIcon />} iconPosition="start" sx={{ minHeight: 36, fontSize: 12 }} />
        <Tab
          label={t("breakpointPanel.responseTab")}
          icon={<RuleRoundedIcon />}
          iconPosition="start"
          sx={{ minHeight: 36, fontSize: 12 }}
          disabled={isRequestStage && !mockMode}
        />
      </Tabs>

      <Box sx={{ flex: 1, overflow: "auto", px: 2, py: 1.5 }}>
        {tab === 0 && (
          <Stack spacing={1.5}>
            <HeaderEditor
              addLabel={t("common.actions.addHeader")}
              headers={reqHeaders}
              namePlaceholder={t("common.placeholders.name")}
              onChange={(h) => setEditedReqHeaders(h)}
              valuePlaceholder={t("common.placeholders.value")}
            />
            <BodyEditor
              label={t("breakpointPanel.requestBody")}
              text={reqBody}
              onChange={(t) => setEditedReqBody(t)}
            />
          </Stack>
        )}
        {tab === 1 && (
          <Stack spacing={1.5}>
            {!isRequestStage && activeHit.responseStatusCode != null && (
              <Typography variant="caption" color="text.secondary">
                {t("breakpointPanel.status")} {activeHit.responseStatusCode}
              </Typography>
            )}
            {mockMode ? (
              <>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="caption" color="text.secondary">{t("breakpointPanel.status")}</Typography>
                  <OutlinedInput
                    size="small"
                    type="number"
                    value={mockStatusCode}
                    onChange={(e) => setMockStatusCode(e.target.value)}
                    sx={{ width: 80, fontFamily: fontFamilies.mono, fontSize: 12 }}
                  />
                </Stack>
                <HeaderEditor
                  addLabel={t("common.actions.addHeader")}
                  headers={mockHeaders}
                  namePlaceholder={t("common.placeholders.name")}
                  onChange={setMockHeaders}
                  valuePlaceholder={t("common.placeholders.value")}
                />
                <BodyEditor label={t("breakpointPanel.responseBody")} text={mockBody} onChange={setMockBody} />
              </>
            ) : (
              <>
                <HeaderEditor
                  addLabel={t("common.actions.addHeader")}
                  headers={respHeaders}
                  namePlaceholder={t("common.placeholders.name")}
                  onChange={(h) => setEditedRespHeaders(h)}
                  valuePlaceholder={t("common.placeholders.value")}
                />
                <BodyEditor
                  label={t("breakpointPanel.responseBody")}
                  text={respBody}
                  onChange={(t) => setEditedRespBody(t)}
                />
              </>
            )}
          </Stack>
        )}
      </Box>

      <Divider />

      {/* Action buttons */}
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 2, py: 1, justifyContent: "flex-end", bgcolor: "action.hover" }}
      >
        {isRequestStage && !mockMode && (
          <Button
            size="small"
            variant="outlined"
            color="warning"
            onClick={() => {
              setMockMode(true);
              setTab(1);
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
        <Button
          size="small"
          variant="outlined"
          color="error"
          startIcon={<DeleteRoundedIcon />}
          onClick={() => handleResolve("drop")}
          sx={{ fontSize: 12 }}
        >
          {t("breakpointPanel.drop")}
        </Button>
        <Button
          size="small"
          variant="contained"
          color="success"
          startIcon={<CheckCircleRoundedIcon />}
          onClick={() => handleResolve(mockMode ? "mock" : "forward")}
          sx={{ fontSize: 12 }}
        >
          {mockMode ? t("common.actions.sendMock") : t("common.actions.forward")}
        </Button>
      </Stack>
    </Paper>
  );
}
