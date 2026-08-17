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
  multiSelectedSessionIds: Set<string>;
  sessionSelectionNonce: number;
  handleSelectedSessionChange: (
    sessionId: string,
    options?: { additive?: boolean; range?: boolean },
  ) => void;
  clearMultiSelection: () => void;
  /** Force-bump the selection nonce (used by repeat/import flows). */
  bumpSelectionNonce: () => void;
}

export interface UseSessionSelectionParams {
  visibleSessions: SessionSummary[];
  /**
   * Session ids in visual tree order (see collectVisibleSessionIds). Used for
   * Shift+click range selection so the range matches what the user sees.
   */
  visibleSessionOrder: string[];
  activeSessions: SessionSummary[];
  selectedSessionId: string | undefined;
  locallyTimedOutSessionIds: Set<string>;
  updateContainer: (updater: (container: SessionContainer) => SessionContainer) => void;
}

export function useSessionSelection({
  visibleSessions,
  visibleSessionOrder,
  activeSessions,
  selectedSessionId,
  locallyTimedOutSessionIds,
  updateContainer,
}: UseSessionSelectionParams): SessionSelectionState {
  const [sessionSelectionNonce, setSessionSelectionNonce] = useState(0);
  const [multiSelectedSessionIds, setMultiSelectedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [rangeAnchorSessionId, setRangeAnchorSessionId] = useState<string | undefined>(undefined);

  const effectiveMultiSelectedSessionIds = useMemo(() => {
    if (multiSelectedSessionIds.size === 0) {
      return multiSelectedSessionIds;
    }

    const visibleIds = new Set(visibleSessions.map((session) => session.id));
    const pruned = new Set<string>();
    for (const sessionId of multiSelectedSessionIds) {
      if (visibleIds.has(sessionId)) {
        pruned.add(sessionId);
      }
    }
    return pruned;
  }, [multiSelectedSessionIds, visibleSessions]);

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
    (sessionId: string, options?: { additive?: boolean; range?: boolean }) => {
      setSessionSelectionNonce((currentValue) => currentValue + 1);
      updateContainer((container: SessionContainer) => ({
        ...container,
        selectedSessionId: sessionId,
      }));
      writeStorageValue(SELECTED_SESSION_ID_STORAGE_KEY, sessionId);

      if (options?.additive) {
        setMultiSelectedSessionIds((current) => {
          const next = new Set(current);
          if (next.has(sessionId)) {
            next.delete(sessionId);
          } else {
            next.add(sessionId);
          }
          return next;
        });
        return;
      }

      if (options?.range && rangeAnchorSessionId) {
        const anchorIndex = visibleSessionOrder.indexOf(rangeAnchorSessionId);
        const targetIndex = visibleSessionOrder.indexOf(sessionId);

        if (anchorIndex !== -1 && targetIndex !== -1) {
          const [start, end] =
            anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
          setMultiSelectedSessionIds(
            (current) => new Set([...current, ...visibleSessionOrder.slice(start, end + 1)]),
          );
        }
        return;
      }

      setMultiSelectedSessionIds(new Set());
      setRangeAnchorSessionId(sessionId);
    },
    [rangeAnchorSessionId, updateContainer, visibleSessionOrder],
  );

  const clearMultiSelection = useCallback(() => {
    setMultiSelectedSessionIds(new Set());
    setRangeAnchorSessionId(undefined);
  }, []);

  const bumpSelectionNonce = useCallback(() => {
    setSessionSelectionNonce((v) => v + 1);
  }, []);

  return {
    selectedSession,
    selectedRawSession,
    selectedSessionId: selectedSessionId,
    isSelectedSessionLocallyTimedOut,
    multiSelectedSessionIds: effectiveMultiSelectedSessionIds,
    sessionSelectionNonce,
    handleSelectedSessionChange,
    clearMultiSelection,
    bumpSelectionNonce,
  };
}
