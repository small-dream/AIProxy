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

type BreakpointPanelTab =
  | "requestQuery"
  | "requestHeaders"
  | "requestBody"
  | "responseStatus"
  | "responseHeaders"
  | "responseBody"
  | "raw";

function formatCount(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

function buildQueryEntries(path: string): HeaderEntry[] {
  const queryStart = path.indexOf("?");
  if (queryStart < 0 || queryStart === path.length - 1) {
    return [];
  }

  return Array.from(new URLSearchParams(path.slice(queryStart + 1)).entries()).map(([name, value]) => ({
    name,
    value,
  }));
}

function buildRawRequestText(hit: BreakpointHit, headers: HeaderEntry[], body: string, queryParams: HeaderEntry[]) {
  const basePath = hit.path.split("?")[0] || "/";
  const query = new URLSearchParams(queryParams.map((entry) => [entry.name, entry.value])).toString();
  const path = query ? `${basePath}?${query}` : basePath;
  const head = [
    `${hit.method} ${path} HTTP/1.1`,
    ...headers.map((header) => `${header.name}: ${header.value}`),
  ].join("\r\n");

  return `${head}\r\n\r\n${body}`;
}

function buildRawResponseText(statusCode: string, headers: HeaderEntry[], body: string) {
  const head = [
    `HTTP/1.1 ${Number(statusCode) || 200}`,
    ...headers.map((header) => `${header.name}: ${header.value}`),
  ].join("\r\n");

  return `${head}\r\n\r\n${body}`;
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
  const add = () => onChange([...headers, { name: "", value: "" }]);
  const remove = (idx: number) => onChange(headers.filter((_, i) => i !== idx));
  const update = (idx: number, field: "name" | "value", val: string) =>
    onChange(headers.map((h, i) => (i === idx ? { ...h, [field]: val } : h)));
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
        alignItems="center"
        direction="row"
        spacing={1}
        sx={{ px: 1.25, py: 0.75, borderBottom: 1, borderColor: "divider", bgcolor: "action.hover" }}
      >
        <Typography id={headerId} sx={{ fontSize: 12, fontWeight: 700 }}>{title}</Typography>
        <Typography color="text.secondary" sx={{ flex: 1, fontSize: 11 }}>
          {countLabel}
        </Typography>
        <Button size="small" onClick={add} sx={{ fontSize: 12, minHeight: 26, px: 1 }}>
          + {addLabel}
        </Button>
      </Stack>
      <Stack spacing={0.5} sx={{ maxHeight: 214, overflow: "auto", p: 0.75 }}>
        {headers.length === 0 ? (
          <Typography color="text.secondary" sx={{ px: 0.5, py: 1.25, fontSize: 12 }}>
            {noHeadersLabel}
          </Typography>
        ) : (
          headers.map((h, idx) => (
            <Stack key={idx} direction="row" spacing={0.5}>
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
  metadata,
  label,
  readOnly = false,
  regionLabel,
  text,
  onChange,
}: {
  metadata: string;
  label: string;
  readOnly?: boolean;
  regionLabel: string;
  text: string;
  onChange: (text: string) => void;
}) {
  return (
    <Paper
      aria-label={regionLabel}
      component="section"
      role="region"
      variant="outlined"
      sx={{ borderRadius: 1, minHeight: 0, overflow: "hidden" }}
    >
      <Stack
        alignItems="center"
        direction="row"
        spacing={1}
        sx={{ px: 1.25, py: 0.75, borderBottom: 1, borderColor: "divider", bgcolor: "action.hover" }}
      >
        <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{label}</Typography>
        <Typography color="text.secondary" sx={{ fontSize: 11 }}>
          {metadata}
        </Typography>
      </Stack>
      <Box sx={{ p: 0.75 }}>
        <OutlinedInput
          fullWidth
          inputProps={{ "aria-label": label, readOnly }}
          multiline
          minRows={10}
          maxRows={10}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          sx={{
            alignItems: "flex-start",
            fontFamily: fontFamilies.mono,
            fontSize: 12,
            "& .MuiOutlinedInput-input": {
              height: "240px !important",
              lineHeight: 1.55,
              overflow: "auto !important",
            },
          }}
        />
      </Box>
    </Paper>
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

  const [tab, setTab] = useState<BreakpointPanelTab>("requestQuery");
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
        setEditedReqQueryParams(null);
        setEditedReqHeaders(null);
        setEditedReqBody(null);
        setEditedRespStatusCode(null);
        setEditedRespHeaders(null);
        setEditedRespBody(null);
        setTab("requestQuery");
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
        ...(editedReqQueryParams ? { modifiedRequestQueryParams: editedReqQueryParams } : {}),
        ...(editedReqBody !== null ? { modifiedRequestBodyBase64: btoa(editedReqBody) } : {}),
        ...(editedRespStatusCode !== null ? { modifiedResponseStatusCode: Number(editedRespStatusCode) || 200 } : {}),
        ...(editedRespHeaders ? { modifiedResponseHeaders: editedRespHeaders } : {}),
        ...(editedRespBody !== null ? { modifiedResponseBodyBase64: btoa(editedRespBody) } : {}),
      };

      try {
        await resolveBreakpoint(resolution);
        removePendingHit(activeHit.sessionId);
        setMockMode(false);
        // Reset edits
        setEditedReqQueryParams(null);
        setEditedReqHeaders(null);
        setEditedReqBody(null);
        setEditedRespStatusCode(null);
        setEditedRespHeaders(null);
        setEditedRespBody(null);
      } catch {
        // Error already reported by the command layer
      }
    },
    [
      activeHit,
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
  const statusLabel = activeHit.responseStatusCode != null
    ? `${t("breakpointPanel.status")} ${activeHit.responseStatusCode}`
    : null;
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
  const requestBodyMeta = reqBody.length === 0
    ? t("breakpointPanel.emptyBody")
    : formatCount(
        reqBody.length,
        t("breakpointPanel.characterCountOne", { count: reqBody.length }),
        t("breakpointPanel.characterCountMany", { count: reqBody.length }),
      );
  const responseBodyMeta = respBody.length === 0
    ? t("breakpointPanel.emptyBody")
    : formatCount(
        respBody.length,
        t("breakpointPanel.characterCountOne", { count: respBody.length }),
        t("breakpointPanel.characterCountMany", { count: respBody.length }),
      );
  const mockBodyMeta = mockBody.length === 0
    ? t("breakpointPanel.emptyBody")
    : formatCount(
        mockBody.length,
        t("breakpointPanel.characterCountOne", { count: mockBody.length }),
        t("breakpointPanel.characterCountMany", { count: mockBody.length }),
      );
  const rawRequestText = buildRawRequestText(activeHit, reqHeaders, reqBody, reqQueryParams);
  const rawResponseText = buildRawResponseText(mockMode ? mockStatusCode : respStatusCode, mockMode ? mockHeaders : respHeaders, mockMode ? mockBody : respBody);
  const rawText = tab === "raw" && (!isRequestStage || mockMode) ? `${rawRequestText}\r\n\r\n${rawResponseText}` : rawRequestText;
  const tabSx = { minHeight: 36, fontSize: 12 };
  const responseTabsDisabled = isRequestStage && !mockMode;

  return (
    <Paper
      elevation={8}
      sx={{
        borderTop: 2,
        borderColor: "warning.main",
        display: "flex",
        flexDirection: "column",
        maxHeight: "62vh",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <Stack
        alignItems="center"
        direction="row"
        spacing={1}
        sx={{ px: 2, py: 0.75, borderBottom: 1, borderColor: "divider", minWidth: 0 }}
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
        {statusLabel && <Chip label={statusLabel} size="small" variant="outlined" sx={{ fontSize: 11 }} />}
        {mockMode && <Chip label={t("breakpointPanel.mockMode")} size="small" color="warning" variant="outlined" sx={{ fontSize: 11 }} />}
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

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ minHeight: 36, borderBottom: 1, borderColor: "divider", px: 1 }}
      >
        <Tab value="requestQuery" label={t("breakpointPanel.query")} icon={<CodeRoundedIcon />} iconPosition="start" sx={tabSx} />
        <Tab value="requestHeaders" label={`${t("breakpointPanel.requestHeaders")} (${reqHeaders.length})`} sx={tabSx} />
        <Tab value="requestBody" label={t("breakpointPanel.requestBody")} sx={tabSx} />
        <Tab value="responseStatus" label={t("breakpointPanel.responseStatus")} icon={<RuleRoundedIcon />} iconPosition="start" sx={tabSx} disabled={responseTabsDisabled} />
        <Tab
          value="responseHeaders"
          label={`${t("breakpointPanel.responseHeaders")} (${mockMode ? mockHeaders.length : respHeaders.length})`}
          sx={tabSx}
          disabled={responseTabsDisabled}
        />
        <Tab value="responseBody" label={t("breakpointPanel.responseBody")} sx={tabSx} disabled={responseTabsDisabled} />
        <Tab value="raw" label={t("breakpointPanel.raw")} sx={tabSx} />
      </Tabs>

      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", px: 2, py: 1.5 }}>
        {tab === "requestQuery" && (
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
        {tab === "requestHeaders" && (
          <Box aria-label={t("breakpointPanel.requestHeaders")} role="tabpanel">
            <HeaderEditor
              addLabel={t("common.actions.addHeader")}
              countLabel={requestHeaderCount}
              headers={reqHeaders}
              namePlaceholder={t("common.placeholders.name")}
              noHeadersLabel={t("breakpointPanel.noHeaders")}
              onChange={(h) => setEditedReqHeaders(h)}
              removeLabel={t("breakpointPanel.removeHeader")}
              title={t("breakpointPanel.requestHeaders")}
              valuePlaceholder={t("common.placeholders.value")}
            />
          </Box>
        )}
        {tab === "requestBody" && (
          <Box aria-label={t("breakpointPanel.requestBody")} role="tabpanel">
            <BodyEditor
              metadata={requestBodyMeta}
              label={t("breakpointPanel.requestBody")}
              regionLabel={t("breakpointPanel.body")}
              text={reqBody}
              onChange={(t) => setEditedReqBody(t)}
            />
          </Box>
        )}
        {tab === "responseStatus" && (
          <Box aria-label={t("breakpointPanel.responseStatus")} role="tabpanel">
            <Paper variant="outlined" sx={{ borderRadius: 1, overflow: "hidden" }}>
              <Stack
                alignItems="center"
                direction="row"
                spacing={1}
                sx={{ px: 1.25, py: 0.75, borderBottom: 1, borderColor: "divider", bgcolor: "action.hover" }}
              >
                <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{t("breakpointPanel.responseStatus")}</Typography>
              </Stack>
              <Box sx={{ p: 1.25 }}>
                <OutlinedInput
                  inputProps={{ "aria-label": t("breakpointPanel.responseStatus"), min: 100, max: 599 }}
                  size="small"
                  type="number"
                  value={mockMode ? mockStatusCode : respStatusCode}
                  onChange={(e) => (mockMode ? setMockStatusCode(e.target.value) : setEditedRespStatusCode(e.target.value))}
                  sx={{ width: 112, fontFamily: fontFamilies.mono, fontSize: 12 }}
                />
              </Box>
            </Paper>
          </Box>
        )}
        {tab === "responseHeaders" && (
          <Box aria-label={t("breakpointPanel.responseHeaders")} role="tabpanel">
            <HeaderEditor
              addLabel={t("common.actions.addHeader")}
              countLabel={mockMode ? mockHeaderCount : responseHeaderCount}
              headers={mockMode ? mockHeaders : respHeaders}
              namePlaceholder={t("common.placeholders.name")}
              noHeadersLabel={t("breakpointPanel.noHeaders")}
              onChange={mockMode ? setMockHeaders : (h) => setEditedRespHeaders(h)}
              removeLabel={t("breakpointPanel.removeHeader")}
              title={t("breakpointPanel.responseHeaders")}
              valuePlaceholder={t("common.placeholders.value")}
            />
          </Box>
        )}
        {tab === "responseBody" && (
          <Box aria-label={t("breakpointPanel.responseBody")} role="tabpanel">
            <BodyEditor
              metadata={mockMode ? mockBodyMeta : responseBodyMeta}
              label={t("breakpointPanel.responseBody")}
              regionLabel={t("breakpointPanel.body")}
              text={mockMode ? mockBody : respBody}
              onChange={mockMode ? setMockBody : (t) => setEditedRespBody(t)}
            />
          </Box>
        )}
        {tab === "raw" && (
          <Box aria-label={t("breakpointPanel.raw")} role="tabpanel">
            <BodyEditor
              metadata={formatCount(
                rawText.length,
                t("breakpointPanel.characterCountOne", { count: rawText.length }),
                t("breakpointPanel.characterCountMany", { count: rawText.length }),
              )}
              label={mockMode || !isRequestStage ? t("breakpointPanel.rawExchange") : t("breakpointPanel.rawRequest")}
              readOnly
              regionLabel={t("breakpointPanel.raw")}
              text={rawText}
              onChange={() => undefined}
            />
          </Box>
        )}
      </Box>

      <Divider />

      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 2, py: 1, alignItems: "center", justifyContent: "space-between", bgcolor: "action.hover" }}
      >
        <Box>
          {isRequestStage && !mockMode && (
            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={() => {
                setMockMode(true);
                setTab("responseBody");
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
      </Stack>
    </Paper>
  );
}
