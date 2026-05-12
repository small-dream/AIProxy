import { coerceAppError, isNullableString } from "./common";

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
    isNullableString(candidate.payloadText)
  );
}

export function parseWsMessages(value: unknown): WsMessage[] {
  if (!Array.isArray(value)) {
    throw coerceAppError(value);
  }
  if (value.every(isWsMessage)) {
    return value;
  }
  throw coerceAppError(value);
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

export function isWsConnectionStatusEvent(
  value: unknown,
): value is WsConnectionStatusEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WsConnectionStatusEvent>;
  return (
    typeof candidate.sessionId === "string" &&
    (candidate.status === "active" || candidate.status === "closed")
  );
}
