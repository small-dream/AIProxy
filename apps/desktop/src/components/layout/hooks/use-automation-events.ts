import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  AUTOMATION_CHANGE_QUERY_KEY,
  AUTOMATION_CHANGES_QUERY_KEY,
} from "@/features/automation/automation-query-keys";
import {
  AGENT_AUDIT_QUERY_KEY,
  AGENT_SETTINGS_QUERY_KEY,
} from "@/features/agent-access/agent-access-query-keys";
import { BREAKPOINT_RULES_QUERY_KEY } from "@/features/breakpoints/use-breakpoint-rules";
import {
  DNS_MAPPINGS_QUERY_KEY,
  MAP_RULES_QUERY_KEY,
  REWRITE_RULES_QUERY_KEY,
  SCRIPT_RULES_QUERY_KEY,
} from "@/features/rules/use-rule-center";
import {
  THROTTLE_PROFILES_QUERY_KEY,
  THROTTLE_RULES_QUERY_KEY,
  THROTTLE_STATS_QUERY_KEY,
} from "@/features/throttling/use-throttle-profiles";
import { onAutomationChanged } from "@/services/events";
import { logDevWarn } from "@/services/logger/dev-logger";

/**
 * Applies targeted cache invalidation for backend automation changes. The
 * payload is intentionally not merged into rule caches: group-scoped queries
 * and runtime-derived metadata need the authoritative command response.
 */
export function useAutomationEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void onAutomationChanged(() => {
      if (cancelled) return;
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: REWRITE_RULES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: MAP_RULES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: DNS_MAPPINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SCRIPT_RULES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: BREAKPOINT_RULES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: THROTTLE_PROFILES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: THROTTLE_RULES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: THROTTLE_STATS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AGENT_SETTINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AGENT_AUDIT_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AUTOMATION_CHANGES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AUTOMATION_CHANGE_QUERY_KEY }),
      ]).catch((error) => {
        logDevWarn("events", "automation_changed_refresh_failed", { error });
      });
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        logDevWarn("events", "automation_changed_listen_failed", { error });
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);
}
