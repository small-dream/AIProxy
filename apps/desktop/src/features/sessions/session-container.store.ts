import { create } from "zustand";
import type { SessionSummary } from "@aiproxy/shared-types";

import {
  type SessionContainer,
  type SessionContainerState,
  clearActiveSessionContainer as clearActiveContainerHelper,
  clearOtherSessionsInActiveContainer as clearOtherSessionsHelper,
  closeSessionContainer as closeContainerHelper,
  createAdditionalSessionContainer as addContainerHelper,
  createInitialSessionContainerState,
  getSessionContainerById,
  removeSessionContainerSummary as removeSummaryHelper,
  seedSessionContainers as seedHelper,
  setActiveSessionContainer as selectContainerHelper,
  updateActiveSessionContainer as updateActiveHelper,
  upsertSessionContainerSummary as upsertSummaryHelper,
} from "./session-containers.helpers";

// ---------------------------------------------------------------------------
// Derived data helpers
// ---------------------------------------------------------------------------

function deriveActiveData(state: SessionContainerState) {
  const activeContainer = getSessionContainerById(state, state.activeContainerId);
  const activeSessionIds = activeContainer?.sessionIds ?? [];
  const activeSessionSummaries = activeSessionIds
    .map((id) => state.sessionSummaryById[id])
    .filter((s): s is SessionSummary => Boolean(s));
  return { activeSessionIds, activeSessionSummaries };
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

type InitOptions = Parameters<typeof createInitialSessionContainerState>[0];

export type SessionContainerStoreState = SessionContainerState & {
  activeSessionIds: string[];
  activeSessionSummaries: SessionSummary[];
  hydrated: boolean;

  /** Legacy passthrough — lets the Sessions page push manual sync until it migrates. */
  setActiveSessionIds: (ids: string[]) => void;
  /** Legacy passthrough — lets the Sessions page push manual sync until it migrates. */
  setActiveSessionSummaries: (summaries: SessionSummary[]) => void;

  init: (options?: InitOptions) => void;
  seedSessions: (sessions: SessionSummary[]) => void;
  upsertSummary: (summary: SessionSummary) => void;
  removeSummary: (sessionId: string) => void;
  addContainer: () => void;
  closeContainer: (containerId: string) => void;
  selectContainer: (containerId: string) => void;
  updateActiveContainer: (updater: (container: SessionContainer) => SessionContainer) => void;
  clearSessions: (options?: InitOptions) => void;
  clearOtherSessions: (keepSessionId: string) => void;
  clearActiveContainerSessions: () => void;
};

// ---------------------------------------------------------------------------
// Legacy filter-only state type (kept for backward compatibility)
// ---------------------------------------------------------------------------

export type SessionContainerFilterState = {
  activeSessionIds: string[];
  activeSessionSummaries: SessionSummary[];
  setActiveSessionIds: (ids: string[]) => void;
  setActiveSessionSummaries: (summaries: SessionSummary[]) => void;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSessionContainerStore = create<SessionContainerStoreState>((set, get) => {
  const initialState = createInitialSessionContainerState();
  const derived = deriveActiveData(initialState);

  return {
    ...initialState,
    ...derived,

    setActiveSessionIds(ids: string[]) {
      set({ activeSessionIds: ids });
    },
    setActiveSessionSummaries(summaries: SessionSummary[]) {
      set({ activeSessionSummaries: summaries });
    },

    init(options?: InitOptions) {
      const current = get();
      if (current.hydrated) return;
      const next = createInitialSessionContainerState(options);
      set({ ...next, ...deriveActiveData(next) });
    },

    seedSessions(sessions: SessionSummary[]) {
      const next = seedHelper(get(), sessions);
      set({ ...next, ...deriveActiveData(next) });
    },

    upsertSummary(summary: SessionSummary) {
      const next = upsertSummaryHelper(get(), summary);
      set({ ...next, ...deriveActiveData(next) });
    },

    removeSummary(sessionId: string) {
      const next = removeSummaryHelper(get(), sessionId);
      set({ ...next, ...deriveActiveData(next) });
    },

    addContainer() {
      const next = addContainerHelper(get());
      set({ ...next, ...deriveActiveData(next) });
    },

    closeContainer(containerId: string) {
      const next = closeContainerHelper(get(), containerId);
      set({ ...next, ...deriveActiveData(next) });
    },

    selectContainer(containerId: string) {
      const next = selectContainerHelper(get(), containerId);
      set({ ...next, ...deriveActiveData(next) });
    },

    updateActiveContainer(updater: (container: SessionContainer) => SessionContainer) {
      const next = updateActiveHelper(get(), updater);
      set({ ...next, ...deriveActiveData(next) });
    },

    clearSessions(options?: InitOptions) {
      const next = createInitialSessionContainerState(options);
      set({ ...next, ...deriveActiveData(next) });
    },

    clearOtherSessions(keepSessionId: string) {
      const next = clearOtherSessionsHelper(get(), keepSessionId);
      set({ ...next, ...deriveActiveData(next) });
    },

    clearActiveContainerSessions() {
      const next = clearActiveContainerHelper(get());
      set({ ...next, ...deriveActiveData(next) });
    },
  };
});

// ---------------------------------------------------------------------------
// Legacy alias — existing consumers (Insights page, Sessions page) still
// import `useSessionContainerFilterStore`. It points to the same store so
// the derived `activeSessionIds` / `activeSessionSummaries` fields are
// always in sync.
// ---------------------------------------------------------------------------

export const useSessionContainerFilterStore: typeof useSessionContainerStore =
  useSessionContainerStore;
