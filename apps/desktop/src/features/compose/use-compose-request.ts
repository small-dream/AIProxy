import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ComposedRequestInput, SessionDetail } from "@pharles/shared-types";

import { sendComposedRequest } from "@/services/commands";
import { logDevError, logDevInfo } from "@/services/logger/dev-logger";

const SESSIONS_QUERY_KEY = ["sessions"] as const;

export function useSendComposedRequest() {
  const queryClient = useQueryClient();

  return useMutation<SessionDetail, Error, ComposedRequestInput>({
    mutationFn: (input: ComposedRequestInput) => sendComposedRequest(input),
    onError(error, input) {
      logDevError("ui.compose", "send_composed_request_mutation_failed", {
        error,
        url: input.url,
      });
    },
    onSuccess(detail: SessionDetail) {
      logDevInfo("ui.compose", "send_composed_request_mutation_succeeded", {
        sessionId: detail.id,
        statusCode: detail.summary.statusCode,
      });
      queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });
}
