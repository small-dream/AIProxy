import { create } from "zustand";

import type { AppUpdateInfo, AppUpdateProgress } from "@/services/updater/app-updater";

type AppShellState = {
  navigationExpanded: boolean;
  toggleNavigation: () => void;
  // Update state (ephemeral, shell-wide; subscribed by badge / dialog / settings)
  availableUpdate: AppUpdateInfo | null;
  isChecking: boolean;
  isInstalling: boolean;
  updateProgress: AppUpdateProgress | null;
  isUpdateDialogOpen: boolean;
  setAvailableUpdate: (info: AppUpdateInfo | null) => void;
  setUpdateChecking: (checking: boolean) => void;
  setUpdateInstalling: (installing: boolean) => void;
  setUpdateProgress: (progress: AppUpdateProgress | null) => void;
  setUpdateDialogOpen: (open: boolean) => void;
};

export const useAppShellStore = create<AppShellState>((set) => ({
  navigationExpanded: true,
  toggleNavigation: () => set((state) => ({ navigationExpanded: !state.navigationExpanded })),
  availableUpdate: null,
  isChecking: false,
  isInstalling: false,
  updateProgress: null,
  isUpdateDialogOpen: false,
  setAvailableUpdate: (info) => set({ availableUpdate: info }),
  setUpdateChecking: (checking) => set({ isChecking: checking }),
  setUpdateInstalling: (installing) => set({ isInstalling: installing }),
  setUpdateProgress: (progress) => set({ updateProgress: progress }),
  setUpdateDialogOpen: (open) => set({ isUpdateDialogOpen: open }),
}));
