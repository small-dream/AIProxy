import { create } from "zustand";

export interface AppNotification {
  id: string;
  message: string;
}

/**
 * Maximum number of notifications retained in the queue.
 *
 * M19: a query error storm (e.g. intermittent backend failures, a batch of
 * parallel queries failing at once on a network blip) used to push one entry
 * per failure and let the queue grow unbounded. The Snackbar drains one entry
 * at a time every 4s, so 50 failures became a 200s tail of stale toasts.
 * Capping the queue drops the OLDEST entries so the most recent failures stay
 * visible without flooding the UI long after the underlying issue resolved.
 */
const MAX_QUEUE_SIZE = 5;

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
    set((s) => {
      // M19: collapse consecutive duplicate messages so a polling query that
      // fails repeatedly does not stack N identical toasts. Only the LAST
      // message is compared (the Snackbar plays sequentially), so distinct
      // interleaved errors still surface.
      const last = s.queue[s.queue.length - 1];
      if (last && last.message === message) {
        return { queue: s.queue };
      }
      const nextQueue = [...s.queue, { id, message }];
      // Cap the queue, dropping the oldest entries beyond MAX_QUEUE_SIZE.
      if (nextQueue.length > MAX_QUEUE_SIZE) {
        nextQueue.splice(0, nextQueue.length - MAX_QUEUE_SIZE);
      }
      return { queue: nextQueue };
    });
  },
  shift: () => {
    const [first, ...rest] = get().queue;
    if (first) set({ queue: rest });
    return first;
  },
}));
