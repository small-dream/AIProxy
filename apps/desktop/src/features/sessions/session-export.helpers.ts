import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import type { QueryClient } from "@tanstack/react-query";

import { generateCurlCommand } from "@/features/compose/curl-export";
import { ensureSessionDetailContent } from "./session-detail-content";
import { getSessionProtocolMetadata } from "./session-protocol.helpers";

export function buildSessionSnapshot(details: SessionDetail[]) {
  return {
    exportedAt: new Date().toISOString(),
    sessionCount: details.length,
    sessions: details,
  };
}

export function buildCurlCommand(detail: SessionDetail) {
  return generateCurlCommand({
    method: detail.summary.method,
    url: detail.summary.url,
    headers: detail.requestHeaders,
    ...(getBodyText(detail.requestBody) ? { body: getBodyText(detail.requestBody) } : {}),
  });
}

export function buildCurlBundle(details: SessionDetail[]) {
  return details.map((detail) => buildCurlCommand(detail));
}

export function buildHarArchive(details: SessionDetail[]) {
  return {
    log: {
      version: "1.2",
      creator: {
        name: "AIProxy",
        version: "0.1.0",
      },
      entries: details.map((detail) => {
        const protocolMetadata = getSessionProtocolMetadata(detail.summary);
        const httpVersion = `HTTP/${protocolMetadata.httpVersion}`;

        return {
          startedDateTime: detail.summary.startedAt,
          time: detail.summary.durationMs,
          request: {
            method: detail.summary.method,
            url: detail.summary.url,
            httpVersion,
            headers: detail.requestHeaders.map((header) => ({
              name: header.name,
              value: header.value,
            })),
            queryString: detail.queryParams.map((query) => ({
              name: query.name,
              value: query.value,
            })),
            headersSize: -1,
            bodySize: detail.requestBody?.sizeBytes ?? 0,
            postData: detail.requestBody
              ? {
                  mimeType: detail.requestBody.mimeType ?? "application/octet-stream",
                  text: getBodyText(detail.requestBody),
                }
              : undefined,
          },
          response: {
            status: detail.summary.statusCode,
            statusText: "",
            httpVersion,
            headers: detail.responseHeaders.map((header) => ({
              name: header.name,
              value: header.value,
            })),
            content: {
              size: detail.responseBody?.sizeBytes ?? detail.summary.sizeBytes,
              mimeType:
                detail.responseBody?.mimeType ??
                detail.summary.responseMimeType ??
                "application/octet-stream",
              text: getBodyText(detail.responseBody),
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: detail.responseBody?.sizeBytes ?? detail.summary.sizeBytes,
          },
          cache: {},
          timings: {
            blocked: 0,
            dns: detail.timing?.dnsMs ?? 0,
            connect: detail.timing?.connectMs ?? 0,
            send: detail.timing?.requestSendMs ?? 0,
            wait: detail.timing?.waitingMs ?? 0,
            receive: detail.timing?.responseReadMs ?? 0,
            ssl: detail.timing?.tlsMs ?? 0,
          },
        };
      }),
    },
  };
}

export function buildHarExportFilename(scope: "request" | "host" | "sessions", label?: string) {
  const normalizedLabel = label
    ?.replace(/[^a-zA-Z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const filenameParts = ["aiproxy", scope];

  if (normalizedLabel) {
    filenameParts.push(normalizedLabel);
  }

  filenameParts.push(String(Date.now()));

  return `${filenameParts.join("-")}.har`;
}

export function getBodyText(body: SessionDetail["requestBody"] | SessionDetail["responseBody"]) {
  if (!body) {
    return "";
  }

  if (body.inlineText) {
    return body.inlineText;
  }

  if (body.base64Text) {
    try {
      return atob(body.base64Text);
    } catch {
      return body.base64Text;
    }
  }

  return "";
}

export const EXPORT_BATCH_SIZE = 10;

export const DEFAULT_EXPORT_CONTENT_OPTIONS = {
  includeRawRequest: true,
  includeRawResponse: true,
  includeRequestBodyText: true,
  includeResponseBodyText: true,
  includeRequestBodyBase64: true,
  includeResponseBodyBase64: true,
} as const;

export async function loadSessionDetailsBatched(
  queryClient: QueryClient,
  sessions: SessionSummary[],
  batchSize: number = EXPORT_BATCH_SIZE,
): Promise<SessionDetail[]> {
  if (sessions.length === 0) return [];

  const details: SessionDetail[] = [];
  for (let i = 0; i < sessions.length; i += batchSize) {
    const batch = sessions.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((session) =>
        ensureSessionDetailContent(queryClient, session.id, { ...DEFAULT_EXPORT_CONTENT_OPTIONS }),
      ),
    );
    details.push(...batchResults);
  }
  return details;
}
