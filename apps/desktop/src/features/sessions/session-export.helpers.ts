import type { SessionDetail } from "@aiproxy/shared-types";

import { generateCurlCommand } from "@/features/compose/curl-export";

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
      entries: details.map((detail) => ({
        startedDateTime: detail.summary.startedAt,
        time: detail.summary.durationMs,
        request: {
          method: detail.summary.method,
          url: detail.summary.url,
          httpVersion: detail.summary.protocol.toUpperCase(),
          headers: detail.requestHeaders.map((header) => ({ name: header.name, value: header.value })),
          queryString: detail.queryParams.map((query) => ({ name: query.name, value: query.value })),
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
          httpVersion: detail.summary.protocol.toUpperCase(),
          headers: detail.responseHeaders.map((header) => ({ name: header.name, value: header.value })),
          content: {
            size: detail.responseBody?.sizeBytes ?? detail.summary.sizeBytes,
            mimeType: detail.responseBody?.mimeType ?? detail.summary.responseMimeType ?? "application/octet-stream",
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
      })),
    },
  };
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
