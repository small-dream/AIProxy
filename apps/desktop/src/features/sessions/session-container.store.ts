import { create } from "zustand";
import type { SessionSummary } from "@aiproxy/shared-types";

export type SessionContainerFilterState = {
  activeSessionIds: string[];
  activeSessionSummaries: SessionSummary[];
  setActiveSessionIds: (ids: string[]) => void;
  setActiveSessionSummaries: (summaries: SessionSummary[]) => void;
};

export const useSessionContainerFilterStore = create<SessionContainerFilterState>((set) => ({
  activeSessionIds: [],
  activeSessionSummaries: [],
  setActiveSessionIds: (ids) => set({ activeSessionIds: ids }),
  setActiveSessionSummaries: (summaries) => set({ activeSessionSummaries: summaries }),
}));
