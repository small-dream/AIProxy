import { useCallback } from "react";
import type { SessionSummary } from "@aiproxy/shared-types";

import type { SessionContainer } from "@/features/sessions/session-containers.helpers";
import { useSessionContainerStore } from "@/features/sessions/session-container.store";

export interface SessionRepeatState {
  handleRepeatSession: (session: SessionSummary) => void;
  handleRepeat: () => void;
}

export interface UseSessionRepeatParams {
  selectedSession: SessionSummary | undefined;
  /** The `handleRepeatDirect` callback from `useSessionContextActions`. */
  handleRepeatDirect: (
    session: SessionSummary,
    callbacks?: {
      onFailure?: (pendingSessionId: string) => void;
      onPending?: (summary: SessionSummary) => void;
      onSuccess?: (pendingSessionId: string, summary: SessionSummary) => void;
    },
  ) => Promise<SessionSummary | null>;
  /** A callback that updates the active container (typically aliased from the store). */
  updateContainer: (updater: (container: SessionContainer) => SessionContainer) => void;
  /** Called when the selection nonce should advance (so the inspector re-renders). */
  bumpSelectionNonce: () => void;
}

export function useSessionRepeat({
  selectedSession,
  handleRepeatDirect,
  updateContainer,
  bumpSelectionNonce,
}: UseSessionRepeatParams): SessionRepeatState {
  const store = useSessionContainerStore;

  const handleRepeatSession = useCallback(
    (session: SessionSummary) => {
      void handleRepeatDirect(session, {
        onFailure: (pendingSessionId) => {
          store.getState().removeSummary(pendingSessionId);
          updateContainer((c: SessionContainer) =>
            c.selectedSessionId === pendingSessionId ? { ...c, selectedSessionId: session.id } : c,
          );
        },
        onPending: (summary) => {
          store.getState().upsertSummary(summary);
          updateContainer((c: SessionContainer) => ({ ...c, selectedSessionId: summary.id }));
          bumpSelectionNonce();
        },
        onSuccess: (pendingSessionId, summary) => {
          store.getState().removeSummary(pendingSessionId);
          store.getState().upsertSummary(summary);
          updateContainer((c: SessionContainer) => ({ ...c, selectedSessionId: summary.id }));
          bumpSelectionNonce();
        },
      });
    },
    [handleRepeatDirect, updateContainer, bumpSelectionNonce, store],
  );

  const handleRepeat = useCallback(() => {
    if (!selectedSession) return;
    handleRepeatSession(selectedSession);
  }, [handleRepeatSession, selectedSession]);

  return { handleRepeatSession, handleRepeat };
}
