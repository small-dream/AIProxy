import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import {
  alpha,
  Box,
  Chip,
  IconButton,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WsMessage, WsOpcode } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { listWsMessages } from "@/services/commands";
import { onWsMessage } from "@/services/events";
import { SearchableCodeBlock } from "./SessionInspectorShared";

type DirectionFilter = "all" | "clientToServer" | "serverToClient";
type OpcodeFilter = "all" | "text" | "binary" | "control";
type PayloadFormat = "text" | "json" | "hex";

const CONTROL_OPCODES = new Set<WsOpcode>(["close", "ping", "pong"]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function opcodeColor(opcode: WsOpcode): "success" | "info" | "default" | "warning" {
  if (opcode === "text") return "success";
  if (opcode === "binary") return "info";
  if (opcode === "close") return "warning";
  return "default";
}

function formatTimestamp(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isJsonString(text: string | undefined): boolean {
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function toHexString(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = Array.from(bytes.slice(i, i + 16));
    const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = chunk
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    const offset = i.toString(16).padStart(8, "0");
    lines.push(`${offset}  ${hex.padEnd(48, " ")}  |${ascii}|`);
  }
  return lines.join("\n");
}

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function SessionInspectorMessagesPane({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [opcodeFilter, setOpcodeFilter] = useState<OpcodeFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snackbarOpen, setSnackbarOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listWsMessages(sessionId).then((loaded) => {
      if (!cancelled) setMessages(loaded);
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    const unlisten = onWsMessage((msg) => {
      if (msg.sessionId === sessionId) {
        setMessages((prev) => [...prev, msg]);
      }
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [sessionId]);

  const filtered = useMemo(() => {
    return messages.filter((msg) => {
      if (directionFilter !== "all" && msg.direction !== directionFilter) return false;
      if (opcodeFilter === "text" && msg.opcode !== "text" && msg.opcode !== "continuation") return false;
      if (opcodeFilter === "binary" && msg.opcode !== "binary") return false;
      if (opcodeFilter === "control" && !CONTROL_OPCODES.has(msg.opcode as WsOpcode)) return false;
      if (search) {
        const q = search.toLowerCase();
        const text = msg.payloadText?.toLowerCase() ?? "";
        if (!text.includes(q) && !msg.opcode.includes(q)) return false;
      }
      return true;
    });
  }, [messages, directionFilter, opcodeFilter, search]);

  const selected = useMemo(
    () => messages.find((m) => m.id === selectedId),
    [messages, selectedId],
  );

  const handleDirectionChange = useCallback((_: unknown, val: string) => {
    setDirectionFilter(val as DirectionFilter);
  }, []);

  const handleOpcodeChange = useCallback((_: unknown, val: string) => {
    setOpcodeFilter(val as OpcodeFilter);
  }, []);

  const handleCopy = useCallback(async (text: string) => {
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    setSnackbarOpen(true);
  }, []);

  if (messages.length === 0) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ flex: 1, gap: 1, py: 4 }}>
        <Typography color="text.secondary" variant="body1">
          {t("websocket.emptyTitle")}
        </Typography>
        <Typography color="text.secondary" variant="body2">
          {t("websocket.emptyDescription")}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      <Stack direction="row" spacing={1} sx={{ px: 1, py: 0.5, alignItems: "center" }}>
        <Tabs onChange={handleDirectionChange} sx={{ minHeight: 28 }} value={directionFilter}>
          <Tab label={t("websocket.directionAll")} sx={{ minHeight: 28, py: 0 }} value="all" />
          <Tab label={t("websocket.directionSent")} sx={{ minHeight: 28, py: 0 }} value="clientToServer" />
          <Tab label={t("websocket.directionReceived")} sx={{ minHeight: 28, py: 0 }} value="serverToClient" />
        </Tabs>
        <Tabs onChange={handleOpcodeChange} sx={{ minHeight: 28 }} value={opcodeFilter}>
          <Tab label={t("websocket.opcodeAll")} sx={{ minHeight: 28, py: 0 }} value="all" />
          <Tab label={t("websocket.opcodeText")} sx={{ minHeight: 28, py: 0 }} value="text" />
          <Tab label={t("websocket.opcodeBinary")} sx={{ minHeight: 28, py: 0 }} value="binary" />
          <Tab label={t("websocket.opcodeControl")} sx={{ minHeight: 28, py: 0 }} value="control" />
        </Tabs>
        <TextField
          size="small"
          placeholder={t("websocket.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ minWidth: 160, "& .MuiInputBase-input": { py: 0.5, fontSize: 13 } }}
        />
      </Stack>

      <Box sx={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <Box sx={{ flex: 1, borderRight: 1, borderColor: "divider", overflow: "auto" }}>
          <Stack spacing={0}>
            {filtered.map((msg) => (
              <MessageRow
                key={msg.id}
                message={msg}
                selected={msg.id === selectedId}
                onClick={() => setSelectedId(msg.id)}
              />
            ))}
          </Stack>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
          {selected ? (
            <MessageDetail
              message={selected}
              onCopy={handleCopy}
            />
          ) : (
            <Typography color="text.secondary" variant="body2" sx={{ pt: 2, textAlign: "center" }}>
              {t("websocket.selectMessage")}
            </Typography>
          )}
        </Box>
      </Box>

      <Snackbar
        autoHideDuration={1800}
        message={t("contextMenu.copiedToClipboard")}
        onClose={() => setSnackbarOpen(false)}
        open={snackbarOpen}
      />
    </Stack>
  );
}

function MessageRow({
  message,
  selected,
  onClick,
}: {
  message: WsMessage;
  selected: boolean;
  onClick: () => void;
}) {
  const theme = useTheme();
  const isSent = message.direction === "clientToServer";
  const preview = message.payloadText
    ? message.payloadText.length > 60
      ? message.payloadText.slice(0, 60) + "..."
      : message.payloadText
    : `[Binary ${formatBytes(message.payloadSize)}]`;

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      onClick={onClick}
      sx={{
        cursor: "pointer",
        px: 1.5,
        py: 0.75,
        mx: 0.5,
        my: 0.25,
        borderRadius: 1,
        bgcolor: selected
          ? "action.selected"
          : isSent
            ? alpha(theme.palette.primary.main, 0.06)
            : "transparent",
        borderLeft: 2,
        borderColor: isSent ? "primary.main" : "transparent",
        "&:hover": {
          bgcolor: selected ? "action.selected" : isSent
            ? alpha(theme.palette.primary.main, 0.1)
            : "action.hover",
        },
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 52, fontVariantNumeric: "tabular-nums" }}>
        {formatTimestamp(message.timestamp)}
      </Typography>
      <Chip
        size="small"
        label={message.opcode}
        color={opcodeColor(message.opcode as WsOpcode)}
        sx={{ height: 20, fontSize: 11, minWidth: 44 }}
      />
      <Typography
        variant="caption"
        sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {preview}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {formatBytes(message.payloadSize)}
      </Typography>
    </Stack>
  );
}

function MessageDetail({
  message,
  onCopy,
}: {
  message: WsMessage;
  onCopy: (text: string) => void;
}) {
  const { t } = useI18n();
  const isSent = message.direction === "clientToServer";
  const canJson = isJsonString(message.payloadText);
  const defaultFormat: PayloadFormat = message.opcode === "binary" ? "hex" : canJson ? "json" : "text";
  const [format, setFormat] = useState<PayloadFormat>(defaultFormat);

  // Reset format when selected message changes
  useEffect(() => {
    setFormat(message.opcode === "binary" ? "hex" : canJson ? "json" : "text");
  }, [message.id, message.opcode, canJson]);

  const formattedPayload = useMemo(() => {
    if (format === "json" && message.payloadText) {
      return formatJson(message.payloadText);
    }
    if (format === "hex" && message.payloadText) {
      return toHexString(message.payloadText);
    }
    return message.payloadText ?? "";
  }, [format, message.payloadText]);

  const copyTarget = useMemo(() => {
    if (format === "json" && message.payloadText) return formatJson(message.payloadText);
    if (format === "hex" && message.payloadText) return toHexString(message.payloadText);
    return message.payloadText ?? "";
  }, [format, message.payloadText]);

  const isBinaryWithoutText = message.opcode === "binary" && !message.payloadText;

  return (
    <Stack spacing={1.5}>
      {/* Frame metadata card */}
      <Box
        sx={{
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
          p: 1.5,
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75, display: "block", fontWeight: 500 }}>
          {t("websocket.frameDetails")}
        </Typography>
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="caption" color="text.secondary">{t("websocket.direction")}:</Typography>
            <Chip
              size="small"
              label={isSent ? t("websocket.directionSent") : t("websocket.directionReceived")}
              color={isSent ? "primary" : "secondary"}
              variant="outlined"
              sx={{ height: 20, fontSize: 11 }}
            />
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="caption" color="text.secondary">{t("websocket.opcode")}:</Typography>
            <Chip
              size="small"
              label={message.opcode}
              color={opcodeColor(message.opcode as WsOpcode)}
              sx={{ height: 20, fontSize: 11 }}
            />
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="caption" color="text.secondary">{t("websocket.fin")}:</Typography>
            <Typography variant="caption" fontWeight={500}>
              {message.fin ? "true" : "false"}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="caption" color="text.secondary">{t("websocket.timestamp")}:</Typography>
            <Typography variant="caption" fontFamily="monospace" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {new Date(message.timestamp).toLocaleString()}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="caption" color="text.secondary">{t("websocket.payloadSize")}:</Typography>
            <Typography variant="caption" fontWeight={500}>
              {formatBytes(message.payloadSize)}
            </Typography>
          </Stack>
        </Stack>
      </Box>

      {/* Format toggle + copy */}
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <ToggleButtonGroup
          size="small"
          value={format}
          exclusive
          onChange={(_, val) => { if (val) setFormat(val as PayloadFormat); }}
          sx={{ height: 28 }}
        >
          <ToggleButton value="text" sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: "none" }}>
            {t("websocket.formatText")}
          </ToggleButton>
          <ToggleButton
            value="json"
            disabled={!canJson}
            sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: "none" }}
          >
            {t("websocket.formatJson")}
          </ToggleButton>
          <ToggleButton value="hex" sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: "none" }}>
            {t("websocket.formatHex")}
          </ToggleButton>
        </ToggleButtonGroup>

        <Tooltip arrow title={t("websocket.copyPayload")}>
          <span>
            <IconButton
              aria-label={t("websocket.copyPayload")}
              disabled={!copyTarget}
              onClick={() => onCopy(copyTarget)}
              size="small"
              sx={{ p: 0.75 }}
            >
              <ContentCopyRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {/* Payload content */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", borderRadius: 1, bgcolor: "background.paper" }}>
        {isBinaryWithoutText ? (
          <Typography color="text.secondary" variant="body2" sx={{ p: 2, textAlign: "center" }}>
            {t("websocket.binaryHexUnavailable", { size: formatBytes(message.payloadSize) })}
          </Typography>
        ) : format === "json" && canJson ? (
          <SearchableCodeBlock code={formattedPayload} language="json" searchQuery="" />
        ) : format === "hex" ? (
          <HexCodeBlock hex={formattedPayload} />
        ) : (
          <SearchableCodeBlock code={formattedPayload} language="plain" searchQuery="" />
        )}
      </Box>
    </Stack>
  );
}

function HexCodeBlock({ hex }: { hex: string }) {
  const theme = useTheme();
  return (
    <Box
      component="pre"
      sx={{
        bgcolor: "background.paper",
        color: "text.primary",
        fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
        fontSize: 12.5,
        lineHeight: 1.6,
        m: 0,
        minHeight: 0,
        overflow: "auto",
        px: 1,
        py: 0.75,
        whiteSpace: "pre",
        wordBreak: "keep-all",
      }}
    >
      {hex.split("\n").map((line, i) => (
        <Box key={i} component="span" sx={{ display: "block" }}>
          <Box component="span" sx={{ color: theme.palette.text.secondary, userSelect: "none" }}>
            {line.slice(0, 10)}
          </Box>
          <Box component="span" sx={{ color: "text.primary" }}>
            {line.slice(10, 58)}
          </Box>
          <Box component="span" sx={{ color: theme.palette.text.secondary, userSelect: "none" }}>
            {line.slice(58)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
