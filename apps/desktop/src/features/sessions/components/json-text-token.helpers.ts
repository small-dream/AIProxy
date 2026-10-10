/**
 * Token and JSON-path resolution for the read-only JSON text viewers (the
 * Response "JSON Text" tab and the request/response fallbacks that render body
 * text as JSON).
 *
 * Those viewers are plain text with syntax-highlight spans, so a native
 * double-click only picks an arbitrary slice of characters: quotes, colons and
 * commas count as word separators, and `"userId": 42,` splits into `userId` and
 * `42`. These helpers resolve the semantic token under a character offset so the
 * UI can snap the selection to it and offer node-level actions (copy key / copy
 * value / copy JSON path).
 */

const JSON_TOKEN_PATTERN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

// Same token alternation as JSON_TOKEN_PATTERN plus the structural characters,
// so a single pass can track the path stack while it walks the document.
const JSON_SCAN_PATTERN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\]]|,/g;

const SIMPLE_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type JsonTextTokenKind = "key" | "string" | "number" | "boolean" | "null";

export type JsonTextToken = {
  /** Offset of the token start in the source text (its opening quote). */
  start: number;
  kind: JsonTextTokenKind;
  /** Text the copy action writes: strings lose their quotes and escapes. */
  copyText: string;
  /** Text the search action uses: strings keep the on-screen escapes. */
  searchText: string;
  /** Selection range; strings select their body so quotes stay out of a copy. */
  selectStart: number;
  selectEnd: number;
};

type JsonScanFrame = {
  container: "object" | "array";
  /** Number of path segments that belong to the container itself. */
  pathLength: number;
  index: number;
};

/**
 * Resolve the JSON token under a caret offset. Offsets that sit on whitespace or
 * structural punctuation resolve to `null` so the caller keeps the native
 * behaviour there.
 */
export function findJsonTextToken(text: string, offset: number): JsonTextToken | null {
  if (text.length === 0 || offset < 0 || offset > text.length) {
    return null;
  }

  // A caret can rest right at a token edge, so probing the previous character
  // keeps `42|` and `"title"|` on the token the pointer visually points at.
  return findTokenAtOffset(text, offset) ?? findTokenAtOffset(text, offset - 1);
}

/**
 * Resolve the JSON path (`$.store.book[0].title`) of the token that starts at
 * `tokenStart`. Returns `null` when the surrounding text is not parseable JSON,
 * which keeps the path action hidden for truncated or non-JSON bodies.
 */
export function resolveJsonTextPath(text: string, tokenStart: number): string | null {
  if (tokenStart < 0 || tokenStart >= text.length) {
    return null;
  }

  const segments: string[] = [];
  const frames: JsonScanFrame[] = [];
  let path: string | null = null;

  // Enter the value that is about to start at the current position: array
  // elements get their index assigned here, object members were already given
  // their key segment by the key token itself.
  const beginValue = (): boolean => {
    const frame = frames[frames.length - 1];

    if (!frame) {
      return true;
    }

    if (frame.container === "array") {
      segments.length = frame.pathLength;
      segments.push(`[${frame.index}]`);
      return true;
    }

    return segments.length > frame.pathLength;
  };

  for (const match of text.matchAll(JSON_SCAN_PATTERN)) {
    const matchStart = match.index ?? 0;

    if (matchStart > tokenStart) {
      break;
    }

    const stringToken = match[1];
    const tokenText = stringToken ?? match[0];

    if (tokenText === "{" || tokenText === "[") {
      if (!beginValue()) {
        return null;
      }

      frames.push({
        container: tokenText === "{" ? "object" : "array",
        pathLength: segments.length,
        index: 0,
      });
      continue;
    }

    if (tokenText === "}" || tokenText === "]") {
      const frame = frames.pop();

      if (!frame) {
        return null;
      }

      segments.length = frame.pathLength;
      continue;
    }

    if (tokenText === ",") {
      const frame = frames[frames.length - 1];

      if (frame?.container === "array") {
        frame.index += 1;
      }
      continue;
    }

    const inner = stringToken ? stringToken.slice(1, -1) : "";

    if (stringToken && match[2]) {
      const frame = frames[frames.length - 1];

      if (!frame || frame.container !== "object") {
        return null;
      }

      segments.length = frame.pathLength;
      segments.push(formatKeySegment(decodeJsonStringToken(stringToken, inner)));

      if (matchStart === tokenStart) {
        path = joinPath(segments);
      }
      continue;
    }

    if (
      stringToken ||
      tokenText === "true" ||
      tokenText === "false" ||
      tokenText === "null" ||
      /^-?\d/.test(tokenText)
    ) {
      if (!beginValue()) {
        return null;
      }

      if (matchStart === tokenStart) {
        path = joinPath(segments);
      }
      continue;
    }

    return null;
  }

  return path;
}

/**
 * Resolve the trimmed line that contains `offset`, used by the triple-click
 * selection: the whole-body `<pre>` is a single block element, so the browser's
 * native paragraph selection would otherwise select the entire body.
 */
export function resolveJsonTextLine(
  text: string,
  offset: number,
): { start: number; end: number } | null {
  if (text.length === 0) {
    return null;
  }

  const clamped = Math.min(Math.max(offset, 0), text.length - 1);
  const lineStart = text.lastIndexOf("\n", Math.max(0, clamped - 1)) + 1;
  const lineBreakIndex = text.indexOf("\n", clamped);
  let start = lineStart;
  let end = lineBreakIndex === -1 ? text.length : lineBreakIndex;

  while (start < end && isWhitespace(text.charAt(start))) {
    start += 1;
  }

  while (end > start && isWhitespace(text.charAt(end - 1))) {
    end -= 1;
  }

  return start >= end ? null : { start, end };
}

function findTokenAtOffset(text: string, offset: number): JsonTextToken | null {
  if (offset < 0) {
    return null;
  }

  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const lineBreakIndex = text.indexOf("\n", offset);
  const lineEnd = lineBreakIndex === -1 ? text.length : lineBreakIndex;
  const localOffset = offset - lineStart;

  if (localOffset < 0) {
    return null;
  }

  for (const match of text.slice(lineStart, lineEnd).matchAll(JSON_TOKEN_PATTERN)) {
    const matchStart = match.index ?? 0;
    const stringToken = match[1];
    const tokenText = stringToken ?? match[0];
    const tokenEnd = matchStart + tokenText.length;
    // A key token owns its colon, so `"a":` resolves to the key even when the
    // pointer sits on the punctuator.
    const hitEnd = match[2] ? matchStart + match[0].length : tokenEnd;

    if (localOffset < matchStart || localOffset > hitEnd) {
      continue;
    }

    const absoluteStart = lineStart + matchStart;
    const absoluteEnd = lineStart + tokenEnd;

    if (stringToken) {
      const inner = stringToken.slice(1, -1);
      return {
        start: absoluteStart,
        kind: match[2] ? "key" : "string",
        copyText: decodeJsonStringToken(stringToken, inner),
        searchText: inner,
        selectStart: absoluteStart + 1,
        selectEnd: absoluteEnd - 1,
      };
    }

    return {
      start: absoluteStart,
      kind:
        tokenText === "true" || tokenText === "false"
          ? "boolean"
          : tokenText === "null"
            ? "null"
            : "number",
      copyText: tokenText,
      searchText: tokenText,
      selectStart: absoluteStart,
      selectEnd: absoluteEnd,
    };
  }

  return null;
}

function decodeJsonStringToken(token: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(token);
    return typeof parsed === "string" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function formatKeySegment(key: string): string {
  if (SIMPLE_KEY_PATTERN.test(key)) {
    return `.${key}`;
  }

  return `["${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

function joinPath(segments: string[]): string {
  return `$${segments.join("")}`;
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}
