import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import {
  alpha,
  Box,
  Button,
  Chip,
  Collapse,
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
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WsConnectionStatusValue,
  WsMessage,
  WsMessageDirection,
  WsOpcode,
} from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { getWsConnectionStatus, injectWsMessage, listWsMessages } from "@/services/commands/ws";
import { onWsConnectionStatus, onWsMessage } from "@/services/events";
import { SearchableCodeBlock } from "./SessionInspectorShared";

type DirectionFilter = "all" | "clientToServer" | "serverToClient";
type OpcodeFilter = "all" | "text" | "binary" | "control";
type PayloadFormat = "text" | "json" | "hex";
type ComposeOpcode = "text" | "ping" | "pong";

const CONTROL_OPCODES = new Set<WsOpcode>(["close", "ping", "pong"]);
const MAX_WS_MESSAGES_IN_MEMORY = 10_000;
const MESSAGE_ROW_HEIGHT = 42;
const MESSAGE_ROW_OVERSCAN = 8;

function trimWsMessages(messages: WsMessage[]): WsMessage[] {
  if (messages.length <= MAX_WS_MESSAGES_IN_MEMORY) {
    return messages;
  }

  return messages.slice(messages.length - MAX_WS_MESSAGES_IN_MEMORY);
}

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
    const ascii = chunk.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
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
  const theme = useTheme();
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [opcodeFilter, setOpcodeFilter] = useState<OpcodeFilter>("all");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 150);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMsg, setSnackbarMsg] = useState("");
  const listContainerRef = useRef<HTMLDivElement | null>(null);

  // Connection status
  const [connectionStatus, setConnectionStatus] = useState<WsConnectionStatusValue>("closed");

  // Compose panel state
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDirection, setComposeDirection] = useState<WsMessageDirection>("clientToServer");
  const [composeOpcode, setComposeOpcode] = useState<ComposeOpcode>("text");
  const [composePayload, setComposePayload] = useState("");
  const [injecting, setInjecting] = useState(false);

  // Load messages
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setSelectedId(null);
    setComposeOpen(false);
    listWsMessages(sessionId).then((loaded) => {
      if (!cancelled) setMessages(trimWsMessages(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Live updates
  useEffect(() => {
    const unlisten = onWsMessage((msg) => {
      if (msg.sessionId === sessionId) {
        setMessages((prev) => trimWsMessages([...prev, msg]));
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [sessionId]);

  // Connection status
  useEffect(() => {
    getWsConnectionStatus(sessionId).then(setConnectionStatus);
    const unlisten = onWsConnectionStatus((evt) => {
      if (evt.sessionId === sessionId) {
        setConnectionStatus(evt.status);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [sessionId]);

  const isActive = connectionStatus === "active";

  const filtered = useMemo(() => {
    return messages.filter((msg) => {
      if (directionFilter !== "all" && msg.direction !== directionFilter) return false;
      if (opcodeFilter === "text" && msg.opcode !== "text" && msg.opcode !== "continuation")
        return false;
      if (opcodeFilter === "binary" && msg.opcode !== "binary") return false;
      if (opcodeFilter === "control" && !CONTROL_OPCODES.has(msg.opcode as WsOpcode)) return false;
      if (debouncedSearch) {
        const q = debouncedSearch.toLowerCase();
        const text = msg.payloadText?.toLowerCase() ?? "";
        if (!text.includes(q) && !msg.opcode.includes(q)) return false;
      }
      return true;
    });
  }, [messages, directionFilter, opcodeFilter, debouncedSearch]);

  const selected = useMemo(() => messages.find((m) => m.id === selectedId), [messages, selectedId]);

  const listVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listContainerRef.current,
    estimateSize: () => MESSAGE_ROW_HEIGHT,
    overscan: MESSAGE_ROW_OVERSCAN,
  });

  const handleDirectionChange = useCallback((_: unknown, val: string) => {
    setDirectionFilter(val as DirectionFilter);
  }, []);

  const handleOpcodeChange = useCallback((_: unknown, val: string) => {
    setOpcodeFilter(val as OpcodeFilter);
  }, []);

  const handleCopy = useCallback(
    async (text: string) => {
      if (!text) return;
      await navigator.clipboard?.writeText(text);
      setSnackbarMsg(t("contextMenu.copiedToClipboard"));
      setSnackbarOpen(true);
    },
    [t],
  );

  const handleEditReplay = useCallback((msg: WsMessage) => {
    if (!msg.payloadText) return;
    setComposeDirection(msg.direction);
    setComposePayload(msg.payloadText);
    setComposeOpcode(
      msg.opcode === "ping" || msg.opcode === "pong" ? (msg.opcode as ComposeOpcode) : "text",
    );
    setComposeOpen(true);
  }, []);

  const handleCompose = useCallback(() => {
    setComposeDirection("clientToServer");
    setComposeOpcode("text");
    setComposePayload("");
    setComposeOpen(true);
  }, []);

  const handleInject = useCallback(async () => {
    if (!composePayload.trim()) return;
    setInjecting(true);
    try {
      await injectWsMessage({
        sessionId,
        direction: composeDirection,
        opcode: composeOpcode,
        payload: composePayload,
        fin: true,
      });
      setComposeOpen(false);
      setComposePayload("");
    } catch {
      setSnackbarMsg(t("websocket.injectionFailed"));
      setSnackbarOpen(true);
    } finally {
      setInjecting(false);
    }
  }, [sessionId, composeDirection, composeOpcode, composePayload, t]);

  if (messages.length === 0) {
    return (
      <Stack
        sx={{
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          gap: 1,
          py: 4
        }}>
        <Typography variant="body1" sx={{
          color: "text.secondary"
        }}>
          {t("websocket.emptyTitle")}
        </Typography>
        <Typography variant="body2" sx={{
          color: "text.secondary"
        }}>
          {t("websocket.emptyDescription")}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* Filter bar */}
      <Stack direction="row" spacing={1} sx={{ px: 1, py: 0.5, alignItems: "center" }}>
        <Tabs onChange={handleDirectionChange} sx={{ minHeight: 28 }} value={directionFilter}>
          <Tab label={t("websocket.directionAll")} sx={{ minHeight: 28, py: 0 }} value="all" />
          <Tab
            label={t("websocket.directionSent")}
            sx={{ minHeight: 28, py: 0 }}
            value="clientToServer"
          />
          <Tab
            label={t("websocket.directionReceived")}
            sx={{ minHeight: 28, py: 0 }}
            value="serverToClient"
          />
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
        <Box sx={{ flex: 1 }} />
        {/* Connection status */}
        <Tooltip
          arrow
          title={t("websocket.connectionStatusTooltip", {
            status: isActive ? t("websocket.connectionActive") : t("websocket.connectionClosed"),
          })}
        >
          <Stack
            direction="row"
            spacing={0.5}
            sx={{
              alignItems: "center",
              cursor: "default"
            }}>
            <FiberManualRecordRoundedIcon
              sx={{ fontSize: 12, color: isActive ? "success.main" : "action.disabled" }}
            />
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {isActive ? t("websocket.connectionActive") : t("websocket.connectionClosed")}
            </Typography>
          </Stack>
        </Tooltip>
        {/* Compose button */}
        <Tooltip arrow title={t("websocket.composeButton")}>
          <span>
            <IconButton size="small" onClick={handleCompose} disabled={!isActive} sx={{ p: 0.5 }}>
              <SendRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {/* Message list + detail */}
      <Box sx={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <Box
          ref={listContainerRef}
          sx={{ flex: 1, borderRight: 1, borderColor: "divider", overflow: "auto" }}
        >
          <Box sx={{ height: listVirtualizer.getTotalSize(), position: "relative" }}>
            {listVirtualizer.getVirtualItems().map((virtualItem) => {
              const msg = filtered[virtualItem.index];
              if (!msg) return null;

              return (
                <Box
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  style={{
                    position: "absolute",
                    top: virtualItem.start,
                    left: 0,
                    width: "100%",
                    height: virtualItem.size,
                  }}
                >
                  <MessageRow
                    message={msg}
                    selected={msg.id === selectedId}
                    isActive={isActive}
                    onClick={() => setSelectedId(msg.id)}
                    onReplay={handleEditReplay}
                  />
                </Box>
              );
            })}
          </Box>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 1.5 }}>
          {selected ? (
            <MessageDetail message={selected} onCopy={handleCopy} />
          ) : (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                pt: 2,
                textAlign: "center"
              }}>
              {t("websocket.selectMessage")}
            </Typography>
          )}
        </Box>
      </Box>
      {/* Compose panel */}
      <Collapse in={composeOpen}>
        <Stack
          spacing={1}
          sx={{
            px: 1.5,
            py: 1,
            borderTop: 1,
            borderColor: "divider",
            bgcolor: alpha(theme.palette.background.default, 0.5),
          }}
        >
          <Typography variant="caption" sx={{
            fontWeight: 500
          }}>
            {t("websocket.composeTitle")}
          </Typography>
          <Stack direction="row" spacing={1} sx={{
            alignItems: "center"
          }}>
            <ToggleButtonGroup
              size="small"
              value={composeDirection}
              exclusive
              onChange={(_, val) => {
                if (val) setComposeDirection(val as WsMessageDirection);
              }}
              sx={{ height: 28 }}
            >
              <ToggleButton
                value="clientToServer"
                sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: "none" }}
              >
                {t("websocket.sendToServer")}
              </ToggleButton>
              <ToggleButton
                value="serverToClient"
                sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: "none" }}
              >
                {t("websocket.sendToClient")}
              </ToggleButton>
            </ToggleButtonGroup>
            <ToggleButtonGroup
              size="small"
              value={composeOpcode}
              exclusive
              onChange={(_, val) => {
                if (val) setComposeOpcode(val as ComposeOpcode);
              }}
              sx={{ height: 28 }}
            >
              <ToggleButton
                value="text"
                sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: "none" }}
              >
                Text
              </ToggleButton>
              <ToggleButton
                value="ping"
                sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: "none" }}
              >
                Ping
              </ToggleButton>
              <ToggleButton
                value="pong"
                sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: "none" }}
              >
                Pong
              </ToggleButton>
            </ToggleButtonGroup>
          </Stack>
          <TextField
            multiline
            minRows={2}
            maxRows={6}
            size="small"
            placeholder={t("websocket.payloadPlaceholder")}
            value={composePayload}
            onChange={(e) => setComposePayload(e.target.value)}
            sx={{ "& .MuiInputBase-input": { fontSize: 13, fontFamily: "monospace" } }}
          />
          <Stack direction="row" spacing={1} sx={{
            justifyContent: "flex-end"
          }}>
            <Button
              size="small"
              onClick={() => setComposeOpen(false)}
              sx={{ textTransform: "none" }}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={!composePayload.trim() || injecting}
              onClick={handleInject}
              startIcon={<SendRoundedIcon fontSize="small" />}
              sx={{ textTransform: "none" }}
            >
              {t("websocket.sendButton")}
            </Button>
          </Stack>
        </Stack>
      </Collapse>
      <Snackbar
        autoHideDuration={1800}
        message={snackbarMsg}
        onClose={() => setSnackbarOpen(false)}
        open={snackbarOpen}
      />
    </Stack>
  );
}

function MessageRowImpl({
  message,
  selected,
  isActive,
  onClick,
  onReplay,
}: {
  message: WsMessage;
  selected: boolean;
  isActive: boolean;
  onClick: () => void;
  onReplay: (msg: WsMessage) => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const isSent = message.direction === "clientToServer";
  const preview = message.payloadText
    ? message.payloadText.length > 60
      ? message.payloadText.slice(0, 60) + "..."
      : message.payloadText
    : `[Binary ${formatBytes(message.payloadSize)}]`;

  const canReplay = isActive && !!message.payloadText;

  return (
    <Stack
      direction="row"
      spacing={1}
      onClick={onClick}
      sx={{
        alignItems: "center",
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
          bgcolor: selected
            ? "action.selected"
            : isSent
              ? alpha(theme.palette.primary.main, 0.1)
              : "action.hover",
        }
      }}>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          minWidth: 52,
          fontVariantNumeric: "tabular-nums"
        }}>
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
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {preview}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          fontVariantNumeric: "tabular-nums"
        }}>
        {formatBytes(message.payloadSize)}
      </Typography>
      {canReplay && (
        <Tooltip arrow title={t("websocket.replayTooltip")}>
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onReplay(message);
            }}
            sx={{ p: 0.25 }}
          >
            <PlayArrowRoundedIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
}

const MessageRow = memo(MessageRowImpl);

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
  const defaultFormat: PayloadFormat =
    message.opcode === "binary" ? "hex" : canJson ? "json" : "text";
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
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            mb: 0.75,
            display: "block",
            fontWeight: 500
          }}>
          {t("websocket.frameDetails")}
        </Typography>
        <Stack direction="row" spacing={2} useFlexGap sx={{
          flexWrap: "wrap"
        }}>
          <Stack direction="row" spacing={0.5} sx={{
            alignItems: "center"
          }}>
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {t("websocket.direction")}:
            </Typography>
            <Chip
              size="small"
              label={isSent ? t("websocket.directionSent") : t("websocket.directionReceived")}
              color={isSent ? "primary" : "secondary"}
              variant="outlined"
              sx={{ height: 20, fontSize: 11 }}
            />
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{
            alignItems: "center"
          }}>
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {t("websocket.opcode")}:
            </Typography>
            <Chip
              size="small"
              label={message.opcode}
              color={opcodeColor(message.opcode as WsOpcode)}
              sx={{ height: 20, fontSize: 11 }}
            />
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{
            alignItems: "center"
          }}>
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {t("websocket.fin")}:
            </Typography>
            <Typography variant="caption" sx={{
              fontWeight: 500
            }}>
              {message.fin ? "true" : "false"}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{
            alignItems: "center"
          }}>
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {t("websocket.timestamp")}:
            </Typography>
            <Typography
              variant="caption"
              sx={{
                fontFamily: "monospace",
                fontVariantNumeric: "tabular-nums"
              }}>
              {new Date(message.timestamp).toLocaleString()}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{
            alignItems: "center"
          }}>
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {t("websocket.payloadSize")}:
            </Typography>
            <Typography variant="caption" sx={{
              fontWeight: 500
            }}>
              {formatBytes(message.payloadSize)}
            </Typography>
          </Stack>
        </Stack>
      </Box>
      {/* Format toggle + copy */}
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          justifyContent: "space-between"
        }}>
        <ToggleButtonGroup
          size="small"
          value={format}
          exclusive
          onChange={(_, val) => {
            if (val) setFormat(val as PayloadFormat);
          }}
          sx={{ height: 28 }}
        >
          <ToggleButton
            value="text"
            sx={{ px: 1.5, py: 0.25, fontSize: 12, textTransform: "none" }}
          >
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
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          borderRadius: 1,
          bgcolor: "background.paper",
        }}
      >
        {isBinaryWithoutText ? (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              p: 2,
              textAlign: "center"
            }}>
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
        fontFamily:
          "'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
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
