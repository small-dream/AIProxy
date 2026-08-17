import { create } from "zustand";
import type { BreakpointHit, BreakpointRule } from "@aiproxy/shared-types";

/**
 * Frontend-stamped arrival time. The backend wait window starts when the
 * breakpoint-hit event is emitted, so a countdown driven by receivedAt is
 * best-effort (± event latency); the authoritative release signal is always
 * the `breakpoint-released` event. A same-session replace (request → response
 * stage of the same session) refreshes the stamp: each stage opens its own
 * wait window.
 */
export type PendingBreakpointHit = BreakpointHit & { receivedAt: number };

type BreakpointState = {
  rules: BreakpointRule[];
  pendingHits: PendingBreakpointHit[];
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
      const stamped: PendingBreakpointHit = { ...hit, receivedAt: Date.now() };
      const existingIdx = state.pendingHits.findIndex(
        (pendingHit) => pendingHit.sessionId === hit.sessionId,
      );
      const pendingHits =
        existingIdx >= 0
          ? state.pendingHits.map((pendingHit, idx) => (idx === existingIdx ? stamped : pendingHit))
          : [...state.pendingHits, stamped];
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
      let activeHitId = state.activeHitId;
      if (state.activeHitId === sessionId) {
        if (remaining) {
          const currentIdx = state.pendingHits.findIndex((h) => h.sessionId === sessionId);
          const nextIdx = Math.min(currentIdx, pendingHits.length - 1);
          activeHitId = pendingHits[nextIdx]?.sessionId ?? pendingHits[0]?.sessionId ?? null;
        } else {
          activeHitId = null;
        }
      }
      return { pendingHits, activeHitId };
    }),

  setActiveHitId: (id) => set({ activeHitId: id }),
}));
