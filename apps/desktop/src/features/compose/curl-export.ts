import type { HeaderEntry } from "@pharles/shared-types";

export function generateCurlCommand(params: {
  method: string;
  url: string;
  headers: HeaderEntry[];
  body?: string;
}): string {
  const parts: string[] = ["curl"];

  if (params.method !== "GET") {
    parts.push(`-X ${params.method}`);
  }

  for (const header of params.headers) {
    if (!header.name.trim()) continue;
    parts.push(`-H '${escapeSingleQuotes(header.name)}: ${escapeSingleQuotes(header.value)}'`);
  }

  if (params.body) {
    parts.push(`-d '${escapeSingleQuotes(params.body)}'`);
  }

  parts.push(`'${escapeSingleQuotes(params.url)}'`);

  return parts.join(" \\\n  ");
}

function escapeSingleQuotes(text: string): string {
  return text.replace(/'/g, "'\\''");
}
