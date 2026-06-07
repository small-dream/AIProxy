import { create } from "zustand";

export interface AppNotification {
  id: string;
  message: string;
}

/**
 * Minimal global store for app-level user-facing notifications.
 *
 * Consumers push notifications here; a single Snackbar in AppShell
 * drains the queue so errors don't pile up in the UI.
 */
interface NotificationStore {
  queue: AppNotification[];
  push: (message: string) => void;
  /** Remove and return the oldest notification, or undefined. */
  shift: () => AppNotification | undefined;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  queue: [],
  push: (message) => {
    const id = crypto.randomUUID();
    set((s) => ({ queue: [...s.queue, { id, message }] }));
  },
  shift: () => {
    const [first, ...rest] = get().queue;
    if (first) set({ queue: rest });
    return first;
  },
}));
