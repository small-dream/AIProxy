/**
 * JSON text helpers that keep numbers exact. `JSON.parse` turns integers beyond
 * ±2^53 into the nearest double, which silently changes 64-bit IDs when a body
 * is shown, compared, or formatted and sent on; these helpers avoid that.
 */

export type JsonValue =
  | null
  | boolean
  | number
  /** An integer beyond ±2^53, kept exact by `parseJsonText`. */
  | bigint
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The JSON Text tab's indentation. */
export const JSON_TEXT_INDENT_SPACES = 4;

/** Compact `JSON.stringify` that writes bigint values as plain integers. */
export function stringifyJsonValue(value: JsonValue): string {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return `[${value.map(stringifyJsonValue).join(",")}]`;
  }

  if (isJsonRecord(value)) {
    const members = Object.entries(value).map(
      ([key, child]) => `${JSON.stringify(key)}:${stringifyJsonValue(child)}`,
    );
    return `{${members.join(",")}}`;
  }

  return JSON.stringify(value);
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Integers with fewer than 16 digits are always within Number.MAX_SAFE_INTEGER. */
const POSSIBLY_UNSAFE_INTEGER_PATTERN = /\d{16}/;
const INTEGER_TOKEN_PATTERN = /^-?\d+$/;

/**
 * `JSON.parse` that keeps integers beyond ±2^53 exact as `bigint`, so the JSON
 * tree shows 64-bit IDs with their real digits. Every other value is what
 * `JSON.parse` returns, and invalid JSON throws the same `SyntaxError`.
 */
export function parseJsonText(text: string): JsonValue {
  const value = JSON.parse(text) as JsonValue;

  if (!POSSIBLY_UNSAFE_INTEGER_PATTERN.test(text)) {
    return value;
  }

  try {
    return parseValidJsonKeepingIntegers(text);
  } catch {
    // Nesting too deep for the recursive parser: keep the native result.
    return value;
  }
}

/** Parse text that `JSON.parse` already accepted, keeping unsafe integers as `bigint`. */
function parseValidJsonKeepingIntegers(text: string): JsonValue {
  let index = 0;

  const skipWhitespace = () => {
    while (index < text.length && isJsonWhitespace(text[index] as string)) index += 1;
  };

  const parseString = (): string => {
    const end = findJsonStringEnd(text, index);
    const token = text.slice(index, end);
    index = end;
    return token.includes("\\") ? (JSON.parse(token) as string) : token.slice(1, -1);
  };

  const parseValue = (): JsonValue => {
    skipWhitespace();
    const char = text[index];

    if (char === "{" || char === "[") {
      const isObject = char === "{";
      const close = isObject ? "}" : "]";
      const entries: Array<[string, JsonValue]> = [];
      const items: JsonValue[] = [];
      index += 1;
      skipWhitespace();

      if (text[index] === close) {
        index += 1;
      } else {
        for (;;) {
          if (isObject) {
            skipWhitespace();
            const key = parseString();
            skipWhitespace();
            index += 1; // ":"
            entries.push([key, parseValue()]);
          } else {
            items.push(parseValue());
          }
          skipWhitespace();
          const separator = text[index];
          index += 1;
          if (separator === close) break;
        }
      }

      // fromEntries defines own properties, so a "__proto__" key stays plain
      // data and duplicate keys keep the last value, as in JSON.parse.
      return isObject ? Object.fromEntries(entries) : items;
    }

    if (char === '"') {
      return parseString();
    }

    const start = index;
    while (index < text.length && !isJsonTokenBoundary(text[index] as string)) index += 1;
    const token = text.slice(start, index);

    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;

    const number = Number(token);
    return Number.isSafeInteger(number) || !INTEGER_TOKEN_PATTERN.test(token)
      ? number
      : BigInt(token);
  };

  return parseValue();
}

/**
 * Pretty-print JSON text exactly like `JSON.stringify(JSON.parse(text), null,
 * indent)`, but by re-indenting the tokens instead of a parse/stringify round-trip, so values such as 64-bit IDs
 * (`1234567890123456789`) and `1.10` keep their exact digits. Strings with
 * escapes are re-serialized, so `\u4e2d` still shows as `中`. The input must
 * already be valid JSON.
 */
export function reindentJsonText(text: string, indent = JSON_TEXT_INDENT_SPACES): string {
  const parts: string[] = [];
  let depth = 0;
  let index = 0;
  const newline = (level: number) => `\n${" ".repeat(level * indent)}`;

  while (index < text.length) {
    const char = text[index] as string;

    switch (char) {
      case '"': {
        const end = findJsonStringEnd(text, index);
        const token = text.slice(index, end);
        parts.push(token.includes("\\") ? JSON.stringify(JSON.parse(token) as string) : token);
        index = end;
        continue;
      }
      case "{":
      case "[": {
        const close = char === "{" ? "}" : "]";
        let next = index + 1;
        while (next < text.length && isJsonWhitespace(text[next] as string)) next += 1;
        if (text[next] === close) {
          parts.push(char, close);
          index = next;
        } else {
          depth += 1;
          parts.push(char, newline(depth));
        }
        break;
      }
      case "}":
      case "]":
        depth -= 1;
        parts.push(newline(depth), char);
        break;
      case ",":
        parts.push(",", newline(depth));
        break;
      case ":":
        parts.push(": ");
        break;
      default: {
        if (isJsonWhitespace(char)) break;
        // A number or literal: copy its source text verbatim.
        let end = index + 1;
        while (end < text.length && !isJsonTokenBoundary(text[end] as string)) end += 1;
        parts.push(text.slice(index, end));
        index = end;
        continue;
      }
    }

    index += 1;
  }

  return parts.join("");
}

/** Index just past the closing quote of the JSON string opening at `start`. */
function findJsonStringEnd(text: string, start: number): number {
  let from = start + 1;
  for (;;) {
    const quote = text.indexOf('"', from);
    if (quote === -1) return text.length;
    let backslashes = 0;
    while (text[quote - 1 - backslashes] === "\\") backslashes += 1;
    if (backslashes % 2 === 0) return quote + 1;
    from = quote + 1;
  }
}

function isJsonWhitespace(char: string) {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function isJsonTokenBoundary(char: string) {
  return isJsonWhitespace(char) || char === "," || char === ":" || char === "]" || char === "}";
}
