import { create } from "zustand";

export type InsightsFilterState = {
  domainFilter: string;
  excludedHosts: string[];
  hostExact: string | null;
  setDomainFilter: (value: string) => void;
  setExcludedHosts: (hosts: string[]) => void;
  setHostExact: (host: string | null) => void;
  resetFilters: () => void;
};

export const useInsightsFilterStore = create<InsightsFilterState>((set) => ({
  domainFilter: "",
  excludedHosts: [],
  hostExact: null,
  setDomainFilter: (value) => set({ domainFilter: value }),
  setExcludedHosts: (hosts) => set({ excludedHosts: hosts }),
  setHostExact: (host) => set({ hostExact: host }),
  resetFilters: () => set({ domainFilter: "", excludedHosts: [], hostExact: null }),
}));
