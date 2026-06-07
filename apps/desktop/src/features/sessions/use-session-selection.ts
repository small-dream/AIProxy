import { useCallback, useMemo, useState } from "react";
import type { SessionSummary } from "@aiproxy/shared-types";

import { writeStorageValue } from "@/features/sessions/session-ui.helpers";
import type { SessionContainer } from "@/features/sessions/session-containers.helpers";

const SELECTED_SESSION_ID_STORAGE_KEY = "aiproxy.sessions.selectedSessionId";

export interface SessionSelectionState {
  selectedSession: SessionSummary | undefined;
  selectedRawSession: SessionSummary | undefined;
  selectedSessionId: string | undefined;
  isSelectedSessionLocallyTimedOut: boolean;
  sessionSelectionNonce: number;
  handleSelectedSessionChange: (sessionId: string) => void;
  /** Force-bump the selection nonce (used by repeat/import flows). */
  bumpSelectionNonce: () => void;
}

export interface UseSessionSelectionParams {
  visibleSessions: SessionSummary[];
  activeSessions: SessionSummary[];
  selectedSessionId: string | undefined;
  locallyTimedOutSessionIds: Set<string>;
  updateContainer: (updater: (container: SessionContainer) => SessionContainer) => void;
}

export function useSessionSelection({
  visibleSessions,
  activeSessions,
  selectedSessionId,
  locallyTimedOutSessionIds,
  updateContainer,
}: UseSessionSelectionParams): SessionSelectionState {
  const [sessionSelectionNonce, setSessionSelectionNonce] = useState(0);

  const selectedSession = useMemo(
    () => visibleSessions.find((session) => session.id === selectedSessionId),
    [selectedSessionId, visibleSessions],
  );

  const selectedRawSession = useMemo(
    () => activeSessions.find((session) => session.id === selectedSessionId),
    [selectedSessionId, activeSessions],
  );

  const isSelectedSessionLocallyTimedOut = Boolean(
    selectedRawSession &&
      selectedRawSession.statusCode <= 0 &&
      selectedSession &&
      (selectedSession.statusCode > 0 || locallyTimedOutSessionIds.has(selectedRawSession.id)),
  );

  const handleSelectedSessionChange = useCallback(
    (sessionId: string) => {
      setSessionSelectionNonce((currentValue) => currentValue + 1);
      updateContainer((container: SessionContainer) => ({
        ...container,
        selectedSessionId: sessionId,
      }));
      writeStorageValue(SELECTED_SESSION_ID_STORAGE_KEY, sessionId);
    },
    [updateContainer],
  );

  const bumpSelectionNonce = useCallback(() => {
    setSessionSelectionNonce((v) => v + 1);
  }, []);

  return {
    selectedSession,
    selectedRawSession,
    selectedSessionId: selectedSessionId,
    isSelectedSessionLocallyTimedOut,
    sessionSelectionNonce,
    handleSelectedSessionChange,
    bumpSelectionNonce,
  };
}
