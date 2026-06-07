import { create } from "zustand";

type AppShellState = {
  navigationExpanded: boolean;
  toggleNavigation: () => void;
};

export const useAppShellStore = create<AppShellState>((set) => ({
  navigationExpanded: true,
  toggleNavigation: () =>
    set((state) => ({
      navigationExpanded: !state.navigationExpanded,
    })),
}));
