import { useQueryClient } from "@tanstack/react-query";
import type { SessionSummary } from "@pharles/shared-types";
import { useEffect } from "react";

import { onSessionUpsert } from "@/services/events";
import { upsertSessionSummary } from "./session-cache.helpers";
import { SESSION_DETAIL_QUERY_KEY } from "./use-session-detail";
import { SESSIONS_QUERY_KEY } from "./use-sessions";

export function useSessionEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    onSessionUpsert((detail) => {
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        upsertSessionSummary(currentSessions, detail.summary),
      );
      queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, detail.id], detail);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [queryClient]);
}
