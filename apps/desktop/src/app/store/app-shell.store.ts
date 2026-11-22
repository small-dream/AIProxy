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
  // Message of the last failed update INSTALL (download/verify/relaunch).
  // Mirrors lastCheckFailed: without it the install buttons silently snap
  // back to idle on failure and the user cannot tell a failed install from
  // a deferred one (review M-8).
  installError: string | null;
  updateProgress: AppUpdateProgress | null;
  isUpdateDialogOpen: boolean;
  setAvailableUpdate: (info: AppUpdateInfo | null) => void;
  setUpdateChecking: (checking: boolean) => void;
  setUpdateInstalling: (installing: boolean) => void;
  setLastCheckFailed: (failed: boolean) => void;
  setInstallError: (message: string | null) => void;
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
  installError: null,
  updateProgress: null,
  isUpdateDialogOpen: false,
  setAvailableUpdate: (info) => set({ availableUpdate: info }),
  setUpdateChecking: (checking) => set({ isChecking: checking }),
  setUpdateInstalling: (installing) => set({ isInstalling: installing }),
  setLastCheckFailed: (failed) => set({ lastCheckFailed: failed }),
  setInstallError: (message) => set({ installError: message }),
  setUpdateProgress: (progress) => set({ updateProgress: progress }),
  setUpdateDialogOpen: (open) => set({ isUpdateDialogOpen: open }),
}));
