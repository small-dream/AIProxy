import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import { Box, Chip, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WsMessage, WsOpcode } from "@aiproxy/shared-types";

import { useI18n } from "@/i18n";
import { listWsMessages } from "@/services/commands";
import { onWsMessage } from "@/services/events";
import { SearchableCodeBlock } from "./SessionInspectorShared";

type DirectionFilter = "all" | "clientToServer" | "serverToClient";
type OpcodeFilter = "all" | "text" | "binary" | "control";

const CONTROL_OPCODES = new Set<WsOpcode>(["close", "ping", "pong"]);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function opcodeColor(opcode: WsOpcode): "success" | "info" | "default" {
  if (opcode === "text") return "success";
  if (opcode === "binary") return "info";
  return "default";
}

export function SessionInspectorMessagesPane({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [opcodeFilter, setOpcodeFilter] = useState<OpcodeFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip
                  size="small"
                  label={selected.direction === "clientToServer" ? "Sent" : "Received"}
                  color={selected.direction === "clientToServer" ? "primary" : "secondary"}
                  variant="outlined"
                />
                <Chip size="small" label={selected.opcode} color={opcodeColor(selected.opcode as WsOpcode)} />
                <Typography variant="caption" color="text.secondary">
                  {formatBytes(selected.payloadSize)}
                </Typography>
              </Stack>
              {selected.payloadText ? (
                <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                  <SearchableCodeBlock code={selected.payloadText} searchQuery="" />
                </Box>
              ) : (
                <Typography color="text.secondary" variant="body2">
                  {t("websocket.binaryPayload", { size: formatBytes(selected.payloadSize) })}
                </Typography>
              )}
            </Stack>
          ) : (
            <Typography color="text.secondary" variant="body2" sx={{ pt: 2, textAlign: "center" }}>
              Select a message to inspect
            </Typography>
          )}
        </Box>
      </Box>
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
  const isSent = message.direction === "clientToServer";
  const preview = message.payloadText
    ? message.payloadText.length > 80
      ? message.payloadText.slice(0, 80) + "..."
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
        bgcolor: selected ? "action.selected" : "transparent",
        "&:hover": { bgcolor: "action.hover" },
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      {isSent ? (
        <ArrowUpwardRoundedIcon sx={{ fontSize: 14, color: "primary.main" }} />
      ) : (
        <ArrowDownwardRoundedIcon sx={{ fontSize: 14, color: "secondary.main" }} />
      )}
      <Chip
        size="small"
        label={message.opcode}
        color={opcodeColor(message.opcode as WsOpcode)}
        sx={{ height: 20, fontSize: 11 }}
      />
      <Typography
        variant="caption"
        sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {preview}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {formatBytes(message.payloadSize)}
      </Typography>
    </Stack>
  );
}
