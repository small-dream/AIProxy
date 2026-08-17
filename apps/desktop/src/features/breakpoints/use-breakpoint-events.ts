import { useEffect } from "react";
import { onBreakpointHit, onBreakpointReleased } from "@/services/events";
import { useNotificationStore } from "@/services/notification.store";
import { sendSystemNotification } from "@/services/notifications/system-notifications";
import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { useI18n } from "@/i18n";
import { useBreakpointStore } from "./breakpoint.store";

export function useBreakpointEvents() {
  const addPendingHit = useBreakpointStore((s) => s.addPendingHit);
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    let unlistenHit: (() => void) | undefined;
    let unlistenReleased: (() => void) | undefined;

    onBreakpointHit((hit) => {
      if (cancelled) return;
      addPendingHit(hit);
      // Optional OS-level notification (review §4.3): a hit while the user is
      // working in another window used to sit invisible until they returned.
      // Only notify when the app is unfocused so the in-app panel stays the
      // primary channel; permission failures degrade silently.
      if (useAppPreferencesStore.getState().breakpointSystemNotifications && !document.hasFocus()) {
        void sendSystemNotification(
          t("breakpointPanel.notificationTitle"),
          t("breakpointPanel.notificationBody", {
            method: hit.method,
            target: `${hit.host}${hit.path}`,
          }),
        );
      }
    }).then((fn) => {
      if (!cancelled) {
        unlistenHit = fn;
      } else {
        fn();
      }
    });

    onBreakpointReleased((released) => {
      if (cancelled) return;
      const { pendingHits, removePendingHit } = useBreakpointStore.getState();
      const hit = pendingHits.find((pending) => pending.sessionId === released.sessionId);
      removePendingHit(released.sessionId);
      if (!hit) return;
      // The backend already forwarded the request unchanged; the toast is the
      // only explanation channel for edits the user may still be typing.
      useNotificationStore.getState().push(
        t("breakpointPanel.releasedToast", {
          method: hit.method,
          target: `${hit.host}${hit.path}`,
        }),
        "warning",
      );
    }).then((fn) => {
      if (!cancelled) {
        unlistenReleased = fn;
      } else {
        fn();
      }
    });

    return () => {
      cancelled = true;
      unlistenHit?.();
      unlistenReleased?.();
    };
  }, [addPendingHit, t]);
}
