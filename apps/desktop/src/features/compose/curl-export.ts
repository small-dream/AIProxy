import type { HeaderEntry } from "@aiproxy/shared-types";

import { detectBrowserPlatform } from "@/services/commands/runtime";

export type CurlPlatform = "windows" | "macos" | "linux";

export function generateCurlCommand(
  params: {
    method: string;
    url: string;
    headers: HeaderEntry[];
    body?: string;
  },
  options?: { platform?: CurlPlatform },
): string {
  const platform = options?.platform ?? detectBrowserPlatform();
  return platform === "windows" ? generateWindowsCurl(params) : generatePosixCurl(params);
}

/**
 * POSIX shell syntax (bash / zsh) for macOS and Linux: single-quoted arguments
 * with `'\''` escaping and `\`-continuation across lines.
 */
function generatePosixCurl({
  method,
  url,
  headers,
  body,
}: {
  method: string;
  url: string;
  headers: HeaderEntry[];
  body?: string;
}): string {
  const parts: string[] = ["curl"];

  if (method !== "GET") {
    parts.push(`-X ${method}`);
  }

  for (const header of headers) {
    if (!header.name.trim()) continue;
    parts.push(`-H '${escapeSingleQuotes(header.name)}: ${escapeSingleQuotes(header.value)}'`);
  }

  if (body) {
    parts.push(`-d '${escapeSingleQuotes(body)}'`);
  }

  parts.push(`'${escapeSingleQuotes(url)}'`);

  return parts.join(" \\\n  ");
}

/**
 * Windows syntax that pastes cleanly into both cmd.exe and PowerShell:
 * double-quoted arguments with `""` escaping (accepted by both shells), emitted
 * as a single line. cmd uses `^` and PowerShell uses a backtick for line
 * continuation and the two have no shared continuation character, so a single
 * long line is the only portable form. Interactive pastes do not expand `%VAR%`,
 * so percent signs are left untouched.
 */
function generateWindowsCurl({
  method,
  url,
  headers,
  body,
}: {
  method: string;
  url: string;
  headers: HeaderEntry[];
  body?: string;
}): string {
  const parts: string[] = ["curl"];

  if (method !== "GET") {
    parts.push(`-X ${method}`);
  }

  for (const header of headers) {
    if (!header.name.trim()) continue;
    parts.push(
      `-H "${escapeForDoubleQuotes(header.name)}: ${escapeForDoubleQuotes(header.value)}"`,
    );
  }

  if (body) {
    parts.push(`-d "${escapeForDoubleQuotes(body)}"`);
  }

  parts.push(`"${escapeForDoubleQuotes(url)}"`);

  return parts.join(" ");
}

function escapeSingleQuotes(text: string): string {
  return text.replace(/'/g, "'\\''");
}

function escapeForDoubleQuotes(text: string): string {
  // Double a literal `"` so it survives the surrounding double quotes in both
  // cmd.exe and PowerShell.
  return text.replace(/"/g, '""');
}
