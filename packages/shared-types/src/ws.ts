import { coerceAppError, isNullableString, type AppError } from "./common";

export type WsMessageDirection = "clientToServer" | "serverToClient";
export type WsOpcode = "text" | "binary" | "close" | "ping" | "pong" | "continuation";

export type WsMessage = {
  id: string;
  sessionId: string;
  direction: WsMessageDirection;
  timestamp: string;
  opcode: WsOpcode;
  payloadText?: string;
  payloadSize: number;
  fin: boolean;
  /** True when reassembly hit the capture cap — the payload is only a prefix of the original message. */
  truncated: boolean;
};

export function isWsMessage(value: unknown): value is WsMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WsMessage>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.sessionId === "string" &&
    (candidate.direction === "clientToServer" || candidate.direction === "serverToClient") &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.opcode === "string" &&
    typeof candidate.payloadSize === "number" &&
    typeof candidate.fin === "boolean" &&
    typeof candidate.truncated === "boolean" &&
    isNullableString(candidate.payloadText)
  );
}

// P2 4.3-1: a batch that fails validation used to throw coerceAppError(array),
// which collapses to "An unexpected error occurred." with no hint at what was
// wrong or where. The structured code below carries the failing indexes and
// bounded previews so callers can diagnose a malformed payload.
export const INVALID_WS_MESSAGES = "INVALID_WS_MESSAGES";

/** How many invalid entries are listed in the message and previewed in details. */
const MAX_REPORTED_INVALID_WS_MESSAGES = 5;

function previewWsMessageEntry(entry: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(entry) ?? String(entry);
  } catch {
    serialized = String(entry);
  }
  return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}

export function parseWsMessages(value: unknown): WsMessage[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }
  if (value.every(isWsMessage)) {
    return value;
  }

  const invalidIndexes: number[] = [];
  const samples: string[] = [];
  value.forEach((entry, index) => {
    if (isWsMessage(entry)) {
      return;
    }
    invalidIndexes.push(index);
    if (samples.length < MAX_REPORTED_INVALID_WS_MESSAGES) {
      samples.push(`[${index}] ${previewWsMessageEntry(entry)}`);
    }
  });

  const listedIndexes = invalidIndexes.slice(0, MAX_REPORTED_INVALID_WS_MESSAGES).join(", ");
  const omitted = invalidIndexes.length > MAX_REPORTED_INVALID_WS_MESSAGES ? ", ..." : "";

  const error: AppError = {
    code: INVALID_WS_MESSAGES,
    message: `${invalidIndexes.length} of ${value.length} WebSocket messages failed validation at indexes [${listedIndexes}${omitted}].`,
    details: {
      totalCount: value.length,
      invalidCount: invalidIndexes.length,
      invalidIndexes,
      samples,
    },
  };
  throw error;
}

// ---------------------------------------------------------------------------
// WebSocket connection status and injection types
// ---------------------------------------------------------------------------

export type WsConnectionStatusValue = "active" | "closed";

export type WsConnectionStatusEvent = {
  sessionId: string;
  status: WsConnectionStatusValue;
};

export type WsInjectInput = {
  sessionId: string;
  direction: WsMessageDirection;
  opcode: "text" | "binary" | "close" | "ping" | "pong";
  payload: string;
  fin?: boolean;
};

export function isWsConnectionStatusEvent(value: unknown): value is WsConnectionStatusEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WsConnectionStatusEvent>;
  return (
    typeof candidate.sessionId === "string" &&
    (candidate.status === "active" || candidate.status === "closed")
  );
}
