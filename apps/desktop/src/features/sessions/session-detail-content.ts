import type {
  SessionDetail,
  SessionDetailContentRequest,
} from "@aiproxy/shared-types";
import { mergeSessionDetailContent } from "@aiproxy/shared-types";
import type { QueryClient } from "@tanstack/react-query";

import {
  getSessionDetail,
  getSessionDetailContent,
} from "@/services/commands";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";

export async function ensureSessionDetailContent(
  queryClient: QueryClient,
  sessionId: string,
  request: Omit<SessionDetailContentRequest, "sessionId">,
): Promise<SessionDetail> {
  let detail = queryClient.getQueryData<SessionDetail>([SESSION_DETAIL_QUERY_KEY, sessionId]);

  if (!detail) {
    detail = await getSessionDetail(sessionId);
    queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, sessionId], detail);
  }

  if (!sessionDetailNeedsContent(detail, request)) {
    return detail;
  }

  const patch = await getSessionDetailContent({
    sessionId,
    ...request,
  });
  const nextDetail = mergeSessionDetailContent(detail, patch);

  queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, sessionId], nextDetail);

  return nextDetail;
}

export function sessionDetailNeedsContent(
  detail: SessionDetail | undefined,
  request: Omit<SessionDetailContentRequest, "sessionId">,
): boolean {
  if (!detail) {
    return true;
  }

  return (
    needsDeferredRaw(detail.rawRequest, detail.rawRequestDeferred, request.includeRawRequest) ||
    needsDeferredRaw(detail.rawResponse, detail.rawResponseDeferred, request.includeRawResponse) ||
    needsDeferredBodyField(
      detail.requestBody?.inlineText,
      detail.requestBody?.textDeferred,
      request.includeRequestBodyText,
    ) ||
    needsDeferredBodyField(
      detail.responseBody?.inlineText,
      detail.responseBody?.textDeferred,
      request.includeResponseBodyText,
    ) ||
    needsDeferredBodyField(
      detail.requestBody?.base64Text,
      detail.requestBody?.base64Deferred,
      request.includeRequestBodyBase64,
    ) ||
    needsDeferredBodyField(
      detail.responseBody?.base64Text,
      detail.responseBody?.base64Deferred,
      request.includeResponseBodyBase64,
    )
  );
}

function needsDeferredRaw(
  value: string | undefined,
  deferred: boolean | undefined,
  requested: boolean | undefined,
) {
  return Boolean(requested && deferred && value === undefined);
}

function needsDeferredBodyField(
  value: string | undefined,
  deferred: boolean | undefined,
  requested: boolean | undefined,
) {
  return Boolean(requested && deferred && value === undefined);
}
