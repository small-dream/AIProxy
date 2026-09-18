import { useEffect } from "react";

import { useI18n } from "@/i18n";
import { onSystemProxyWarning } from "@/services/events";
import { useNotificationStore } from "@/services/notification.store";

/**
 * Surfaces the backend `system-proxy-warning` event as a global warning
 * notification. The backend emits it when the OS system-proxy reapply fails
 * after an otherwise-successful proxy start/restart (H4 in
 * commands/proxy.rs): the proxy is running, but the OS proxy may still point
 * at a stale port. Without this subscription the event was emitted with no
 * listener and the user had no feedback (review H7).
 */
export function useSystemProxyWarning() {
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    onSystemProxyWarning((warning) => {
      if (cancelled) return;
      useNotificationStore
        .getState()
        .push(t("appShell.systemProxyReapplyWarning", { error: warning.error }), "warning");
    }).then((fn) => {
      // If the component unmounted before the listener registered, tear it
      // down immediately so the Tauri listener does not leak (M8).
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [t]);
}
