import { create } from "zustand";

import type { AppUpdateInfo, AppUpdateProgress } from "@/services/updater/app-updater";

type AppShellState = {
  navigationExpanded: boolean;
  toggleNavigation: () => void;
  // Update state (ephemeral, shell-wide; subscribed by badge / dialog / settings)
  availableUpdate: AppUpdateInfo | null;
  isChecking: boolean;
  isInstalling: boolean;
  // True when the last check-for-update call failed (drives dialog title).
  lastCheckFailed: boolean;
  updateProgress: AppUpdateProgress | null;
  isUpdateDialogOpen: boolean;
  setAvailableUpdate: (info: AppUpdateInfo | null) => void;
  setUpdateChecking: (checking: boolean) => void;
  setUpdateInstalling: (installing: boolean) => void;
  setLastCheckFailed: (failed: boolean) => void;
  setUpdateProgress: (progress: AppUpdateProgress | null) => void;
  setUpdateDialogOpen: (open: boolean) => void;
};

export const useAppShellStore = create<AppShellState>((set) => ({
  navigationExpanded: true,
  toggleNavigation: () => set((state) => ({ navigationExpanded: !state.navigationExpanded })),
  availableUpdate: null,
  isChecking: false,
  isInstalling: false,
  lastCheckFailed: false,
  updateProgress: null,
  isUpdateDialogOpen: false,
  setAvailableUpdate: (info) => set({ availableUpdate: info }),
  setUpdateChecking: (checking) => set({ isChecking: checking }),
  setUpdateInstalling: (installing) => set({ isInstalling: installing }),
  setLastCheckFailed: (failed) => set({ lastCheckFailed: failed }),
  setUpdateProgress: (progress) => set({ updateProgress: progress }),
  setUpdateDialogOpen: (open) => set({ isUpdateDialogOpen: open }),
}));
