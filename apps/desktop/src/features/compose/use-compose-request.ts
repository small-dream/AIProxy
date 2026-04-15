import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ComposedRequestInput, SessionDetail, SessionSummary } from "@pharles/shared-types";

import {
  buildPendingComposedSessionDetail,
  removeSessionSummary,
  replaceSessionSummary,
} from "@/features/sessions/session-cache.helpers";
import { SESSION_DETAIL_QUERY_KEY } from "@/features/sessions/use-session-detail";
import { SESSIONS_QUERY_KEY } from "@/features/sessions/use-sessions";
import { sendComposedRequest } from "@/services/commands";
import { logDevError, logDevInfo } from "@/services/logger/dev-logger";

type SendRequestContext = {
  optimisticId?: string;
};

export function useSendComposedRequest() {
  const queryClient = useQueryClient();

  return useMutation<SessionDetail, Error, ComposedRequestInput, SendRequestContext>({
    mutationFn: (input: ComposedRequestInput) => sendComposedRequest(input),
    onMutate(input) {
      const optimisticId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pendingDetail = buildPendingComposedSessionDetail(input, optimisticId);

      if (!pendingDetail) {
        return {};
      }

      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) => [
        ...currentSessions,
        pendingDetail.summary,
      ]);
      queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, optimisticId], pendingDetail);

      return { optimisticId };
    },
    onError(error, input, context) {
      logDevError("ui.compose", "send_composed_request_mutation_failed", {
        error,
        url: input.url,
      });

      if (!context?.optimisticId) {
        return;
      }

      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        removeSessionSummary(currentSessions, context.optimisticId as string),
      );
      queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, context.optimisticId] });
    },
    onSuccess(detail, _input, context) {
      logDevInfo("ui.compose", "send_composed_request_mutation_succeeded", {
        sessionId: detail.id,
        statusCode: detail.summary.statusCode,
      });

      if (context?.optimisticId) {
        queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
          replaceSessionSummary(currentSessions, context.optimisticId as string, detail.summary),
        );
        queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, context.optimisticId] });
      }

      queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, detail.id], detail);
    },
  });
}
