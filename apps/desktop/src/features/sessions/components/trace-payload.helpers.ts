import { reindentJsonText, type JsonValue } from "./session-inspector.helpers";

export type TracePayloadView = {
  language: "json" | "plain";
  text: string;
};

/** Mirrors `MAX_LOG_ENTRY_BYTES` in crates/rule-engine/src/types.rs. */
export const SCRIPT_TRACE_PAYLOAD_LIMIT_BYTES = 8 * 1024;

/** Collapsed trace values show at most this many lines. */
export const TRACE_PAYLOAD_COLLAPSED_LINES = 8;
// A long single-line value (an encrypted header, a base64 blob) wraps into
// many visual lines, so length alone also triggers collapsing.
const TRACE_PAYLOAD_COLLAPSE_CHARS = 600;

function tryParseJson(text: string): { ok: true; value: JsonValue } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function isJsonContainer(value: JsonValue): boolean {
  return value !== null && typeof value === "object";
}

/**
 * Turn a recorded trace value into display text. JSON documents are
 * pretty-printed like the JSON text tab (re-indented, so 64-bit numbers keep
 * their digits); a serialized string is shown as its content (and
 * pretty-printed when it holds a JSON document itself); anything unparseable,
 * such as a value cut at the size limit, is kept verbatim.
 *
 * `raw` values (rewrite before/after, recorded as plain header or body text)
 * are never reformatted or unquoted, only highlighted when they are JSON.
 */
export function formatTracePayload(raw: string, options: { raw?: boolean } = {}): TracePayloadView {
  const parsed = tryParseJson(raw);
  if (!parsed.ok) {
    return { language: "plain", text: raw };
  }

  if (options.raw) {
    return { language: "json", text: raw };
  }

  if (typeof parsed.value === "string") {
    const inner = tryParseJson(parsed.value);
    if (inner.ok && isJsonContainer(inner.value)) {
      return { language: "json", text: reindentJsonText(parsed.value) };
    }
    return { language: "plain", text: parsed.value };
  }

  if (isJsonContainer(parsed.value)) {
    return { language: "json", text: reindentJsonText(raw) };
  }

  return { language: "json", text: raw };
}

export function shouldCollapseTracePayload(text: string): boolean {
  if (text.length > TRACE_PAYLOAD_COLLAPSE_CHARS) {
    return true;
  }

  let lineCount = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lineCount += 1;
      if (lineCount > TRACE_PAYLOAD_COLLAPSED_LINES) {
        return true;
      }
    }
  }

  return false;
}
