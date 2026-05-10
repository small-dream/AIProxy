import { create } from "zustand";
import type { BreakpointHit, BreakpointRule } from "@aiproxy/shared-types";

type BreakpointState = {
  rules: BreakpointRule[];
  pendingHits: BreakpointHit[];
  activeHitId: string | null;

  setRules: (rules: BreakpointRule[]) => void;
  addPendingHit: (hit: BreakpointHit) => void;
  removePendingHit: (sessionId: string) => void;
  setActiveHitId: (id: string | null) => void;
};

export const useBreakpointStore = create<BreakpointState>((set) => ({
  rules: [],
  pendingHits: [],
  activeHitId: null,

  setRules: (rules) => set({ rules }),

  addPendingHit: (hit) =>
    set((state) => {
      const existingIdx = state.pendingHits.findIndex((pendingHit) => pendingHit.sessionId === hit.sessionId);
      const pendingHits = existingIdx >= 0
        ? state.pendingHits.map((pendingHit, idx) => (idx === existingIdx ? hit : pendingHit))
        : [...state.pendingHits, hit];
      return {
        pendingHits,
        // Auto-select the first hit if nothing is active
        activeHitId: state.activeHitId ?? hit.sessionId,
      };
    }),

  removePendingHit: (sessionId) =>
    set((state) => {
      const pendingHits = state.pendingHits.filter((h) => h.sessionId !== sessionId);
      const remaining = pendingHits.length > 0;
      let activeHitId: string | null = null;
      if (remaining) {
        const currentIdx = state.pendingHits.findIndex((h) => h.sessionId === sessionId);
        const nextIdx = Math.min(currentIdx, pendingHits.length - 1);
        activeHitId = pendingHits[nextIdx]?.sessionId ?? pendingHits[0]?.sessionId ?? null;
      }
      return { pendingHits, activeHitId };
    }),

  setActiveHitId: (id) => set({ activeHitId: id }),
}));
