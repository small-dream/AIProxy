import type { HeaderEntry } from "@aiproxy/shared-types";

export type ParsedCurlCommand = {
  body?: string;
  bodyType: "formdata" | "raw" | "urlencoded";
  formDataEntries: HeaderEntry[];
  formFiles: Array<{ name: string; fileName: string; filePath: string }>;
  headers: HeaderEntry[];
  method: string;
  url: string;
};

/**
 * Tokenize a cURL command. Handles POSIX single-quoted arguments (with
 * `'\''` escapes) and Windows double-quoted arguments (with `""` escapes) —
 * symmetric with curl-export.ts. Backslash continuations are joined first.
 */
export function tokenizeCurlCommand(command: string): string[] {
  const joined = command
    .replace(/\\\r?\n/g, " ")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!joined) return [];
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < joined.length; index += 1) {
    const char = joined[index] ?? "";
    if (quote === "'") {
      if (char === "'") {
        // POSIX: '\'' closes, escapes a single quote, reopens.
        if (joined.slice(index, index + 4) === "'\\''") {
          current += "'";
          index += 3;
        } else {
          quote = null;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"' && joined[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'") {
      quote = "'";
    } else if (char === '"') {
      quote = '"';
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function parseValueWithPossibleFile(token: string): {
  name: string;
  value: string;
  isFile: boolean;
} | null {
  const equalIndex = token.indexOf("=");
  if (equalIndex < 0) return null;
  const name = token.slice(0, equalIndex);
  const value = token.slice(equalIndex + 1);
  return { name, value, isFile: value.startsWith("@") };
}

/**
 * Parse a cURL command into a composed-request shape. Returns `null` when the
 * URL is missing or not http(s) (C4).
 */
export function parseCurlCommand(command: string): ParsedCurlCommand | null {
  const tokens = tokenizeCurlCommand(command);
  const cmd = tokens[0]?.toLowerCase();
  if (!cmd || !(cmd === "curl" || cmd.endsWith("/curl") || cmd === "curl.exe")) {
    return null;
  }

  let method = "GET";
  const headers: HeaderEntry[] = [];
  const dataArgs: string[] = [];
  const formParts: Array<{ name: string; value: string; isFile: boolean }> = [];
  let url: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-X" || token === "--request") {
      method = tokens[++index]?.toUpperCase() ?? method;
    } else if (token === "-H" || token === "--header") {
      const header = tokens[++index];
      if (header) {
        const colon = header.indexOf(":");
        if (colon > 0) {
          headers.push({
            name: header.slice(0, colon).trim(),
            value: header.slice(colon + 1).trim(),
          });
        }
      }
    } else if (token === "-d" || token === "--data" || token === "--data-raw") {
      const value = tokens[++index];
      if (value !== undefined) dataArgs.push(value);
    } else if (token === "--data-binary") {
      const value = tokens[++index];
      if (value !== undefined) dataArgs.push(value);
    } else if (token === "-F" || token === "--form") {
      const value = tokens[++index];
      const parsed = value !== undefined ? parseValueWithPossibleFile(value) : null;
      if (parsed) formParts.push(parsed);
    } else if (token === "-u" || token === "--user") {
      // Skip the credentials argument (kept out of the import).
      index += 1;
    } else if (token !== undefined && !token.startsWith("-") && url === undefined) {
      url = token;
    }
  }

  if (!url || !/^https?:\/\//i.test(url)) {
    return null;
  }

  // -d without an explicit urlencoded content-type is raw JSON/text.
  const contentType = headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  const isUrlEncoded = contentType.includes("application/x-www-form-urlencoded");

  if (formParts.length > 0) {
    const formDataEntries: HeaderEntry[] = [];
    const formFiles: ParsedCurlCommand["formFiles"] = [];
    for (const part of formParts) {
      if (part.isFile) {
        const filePath = part.value.slice(1);
        formFiles.push({
          name: part.name,
          fileName: filePath.split(/[\\/]/).pop() ?? filePath,
          filePath,
        });
      } else {
        formDataEntries.push({ name: part.name, value: part.value });
      }
    }
    return {
      bodyType: "formdata",
      formDataEntries,
      formFiles,
      headers,
      method,
      url,
    };
  }

  if (dataArgs.length > 0) {
    const body = dataArgs.join("&");
    if (isUrlEncoded) {
      return {
        body,
        bodyType: "urlencoded",
        formDataEntries: [],
        formFiles: [],
        headers,
        method,
        url,
      };
    }
    return { body, bodyType: "raw", formDataEntries: [], formFiles: [], headers, method, url };
  }

  return { bodyType: "raw", formDataEntries: [], formFiles: [], headers, method, url };
}
