import { useQueryClient } from "@tanstack/react-query";
import type { AgentControlActionEvent } from "@aiproxy/shared-types";
import { useEffect } from "react";

import { CERTIFICATE_STATUS_QUERY_KEY } from "@/features/certificate-center/use-certificate-status";
import { PROXY_STATUS_QUERY_KEY } from "@/features/proxy-status/use-proxy-status";
import { SESSION_DETAIL_QUERY_KEY } from "@/features/sessions/use-session-detail";
import { SESSIONS_QUERY_KEY } from "@/features/sessions/use-sessions";
import { WORKSPACES_KEY } from "@/features/workspace-manager/use-workspaces";
import { useI18n, type TranslationKey } from "@/i18n";
import { getRecentAgentControlActions } from "@/services/commands";
import { onAgentControlAction } from "@/services/events";
import { logDevWarn } from "@/services/logger/dev-logger";
import { useNotificationStore } from "@/services/notification.store";

const SEEN_EVENTS_KEY = "aiproxy.agent-control.seen-events.v1";
const MAX_SEEN_EVENTS = 200;
const ACTION_LABEL_KEYS: Record<string, TranslationKey> = {
  clearSessions: "appShell.agentControlClearSessions",
  configureWorkspace: "appShell.agentControlConfigureWorkspace",
  deleteSessions: "appShell.agentControlDeleteSessions",
  generateCertificate: "appShell.agentControlGenerateCertificate",
  openCertificateInstaller: "appShell.agentControlOpenCertificateInstaller",
  removeCertificateTrust: "appShell.agentControlRemoveCertificateTrust",
  setSystemProxy: "appShell.agentControlSetSystemProxy",
  startCapture: "appShell.agentControlStartCapture",
  stopCapture: "appShell.agentControlStopCapture",
};

function readSeenEventIds(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(SEEN_EVENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function rememberSeenEventId(seen: Set<string>, eventId: string) {
  seen.add(eventId);
  while (seen.size > MAX_SEEN_EVENTS) {
    const oldest = seen.values().next().value;
    if (typeof oldest !== "string") break;
    seen.delete(oldest);
  }
  try {
    window.sessionStorage.setItem(SEEN_EVENTS_KEY, JSON.stringify([...seen]));
  } catch {
    // Replay deduplication is best-effort; live event handling must continue.
  }
}

/**
 * Keeps the UI consistent with Agent control actions executed by the desktop
 * process, which bypass the normal React mutation hooks.
 */
export function useAgentControlEvents() {
  const queryClient = useQueryClient();
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const seen = readSeenEventIds();

    const processEvent = (event: AgentControlActionEvent) => {
      if (cancelled || seen.has(event.eventId)) return;
      rememberSeenEventId(seen, event.eventId);

      // Reading status is observational and does not change any query data.
      if (event.method === "getStatus") return;

      void Promise.all([
        queryClient.invalidateQueries({ queryKey: PROXY_STATUS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY }),
        queryClient.invalidateQueries({ queryKey: CERTIFICATE_STATUS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY }),
      ]).catch((error) => {
        logDevWarn("events", "agent_control_action_refresh_failed", { error });
      });
      if (event.method === "deleteSessions" || event.method === "clearSessions") {
        queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY] });
      }

      const labelKey = ACTION_LABEL_KEYS[event.method];
      const action = labelKey ? t(labelKey) : event.actionSummary?.trim() || event.method;
      if (event.ok) {
        useNotificationStore
          .getState()
          .push(t("appShell.agentControlActionSuccess", { action }), "success");
      } else {
        useNotificationStore.getState().push(
          t("appShell.agentControlActionFailure", {
            action,
            code: event.errorCode ?? "UNKNOWN",
          }),
          "error",
        );
      }
    };

    void onAgentControlAction(processEvent)
      .catch((error) => {
        logDevWarn("events", "agent_control_action_listen_failed", { error });
        return () => {};
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
        // Replay remains useful even if the live listener could not be
        // registered, so fetch it after either outcome.
        return getRecentAgentControlActions();
      })
      .then((events) => {
        if (cancelled) return;
        for (const event of events) {
          processEvent(event);
        }
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient, t]);
}
