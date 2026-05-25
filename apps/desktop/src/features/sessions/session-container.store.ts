import { create } from "zustand";

export type SessionContainerFilterState = {
  activeSessionIds: string[];
  setActiveSessionIds: (ids: string[]) => void;
};

export const useSessionContainerFilterStore = create<SessionContainerFilterState>((set) => ({
  activeSessionIds: [],
  setActiveSessionIds: (ids) => set({ activeSessionIds: ids }),
}));
