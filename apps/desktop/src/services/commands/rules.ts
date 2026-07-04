import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  DEFAULT_WORKSPACE_ID,
  parseDnsMappings,
  parseMapSessionTrace,
  parseMapRules,
  parseBreakpointRules,
  parseRewriteRules,
  parseRewriteSessionTrace,
  parseScriptRules,
  parseScriptSessionTrace,
  parseScriptSourceFile,
  type BreakpointResolution,
  type BreakpointRule,
  type DnsMappingRule,
  type MapSessionTrace,
  type MapRule,
  type RewriteRule,
  type RewriteSessionTrace,
  type ScriptRule,
  type ScriptSessionTrace,
  type ScriptSourceFile,
} from "@aiproxy/shared-types";

import { logDevDebug, logDevInfo } from "@/services/logger/dev-logger";

import { getImportedSessionDetail } from "@/features/sessions/imported-sessions.store";

import { isTauriRuntime, reportCommandFailure, shouldFallbackToLocalStore } from "./runtime";

const REWRITE_RULES_STORAGE_KEY = "aiproxy.rules.rewrite";
const MAP_RULES_STORAGE_KEY = "aiproxy.rules.map";
const DNS_MAPPINGS_STORAGE_KEY = "aiproxy.rules.dns";
const SCRIPT_RULES_STORAGE_KEY = "aiproxy.rules.script";

function readStoredRules<T>(storageKey: string, parser: (value: unknown) => T[]): T[] {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return [];
  }

  const rawValue = window.localStorage.getItem(storageKey);

  if (!rawValue) {
    return [];
  }

  try {
    return parser(JSON.parse(rawValue));
  } catch (error) {
    reportCommandFailure(`read_local_store:${storageKey}`, error);
    return [];
  }
}

function writeStoredRules(storageKey: string, value: unknown) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(value));
}

function upsertStoredEntity<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);

  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item) => (item.id === nextItem.id ? nextItem : item));
}

export async function listBreakpointRules(): Promise<BreakpointRule[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_breakpoint_rules_bypassed_non_tauri_runtime");
    return [];
  }

  try {
    logDevDebug("ui.commands", "list_breakpoint_rules_requested");
    const payload = await invoke<unknown>("list_breakpoint_rules");
    const rules = parseBreakpointRules(payload);
    logDevDebug("ui.commands", "list_breakpoint_rules_succeeded", { count: rules.length });
    return rules;
  } catch (error) {
    reportCommandFailure("list_breakpoint_rules", error);
    throw coerceAppError(error);
  }
}

export async function setBreakpointRules(rules: BreakpointRule[]): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "set_breakpoint_rules_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "set_breakpoint_rules_requested", { count: rules.length });
    await invoke("set_breakpoint_rules", { rules });
    logDevInfo("ui.commands", "set_breakpoint_rules_succeeded");
  } catch (error) {
    reportCommandFailure("set_breakpoint_rules", error);
    throw coerceAppError(error);
  }
}

export async function resolveBreakpoint(resolution: BreakpointResolution): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "resolve_breakpoint_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "resolve_breakpoint_requested", {
      sessionId: resolution.sessionId,
      action: resolution.action,
    });
    await invoke("resolve_breakpoint", { resolution });
    logDevInfo("ui.commands", "resolve_breakpoint_succeeded");
  } catch (error) {
    reportCommandFailure("resolve_breakpoint", error);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// Rewrite / Map / Throttling commands
// ---------------------------------------------------------------------------

export async function listRewriteRules(workspaceId = DEFAULT_WORKSPACE_ID): Promise<RewriteRule[]> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_rewrite_rules", {
        input: { workspaceId },
      });

      return parseRewriteRules(payload);
    } catch (error) {
      reportCommandFailure("list_rewrite_rules", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return readStoredRules(REWRITE_RULES_STORAGE_KEY, parseRewriteRules).filter(
    (rule) => rule.workspaceId === workspaceId,
  );
}

export async function saveRewriteRule(
  input: Omit<RewriteRule, "id"> & { id?: string },
): Promise<RewriteRule> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("save_rewrite_rule", {
        input,
      });

      const [savedRule] = parseRewriteRules([payload]);
      return savedRule!;
    } catch (error) {
      reportCommandFailure("save_rewrite_rule", error, input.workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const rules = readStoredRules(REWRITE_RULES_STORAGE_KEY, parseRewriteRules);
  const nextRule = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as RewriteRule;

  writeStoredRules(REWRITE_RULES_STORAGE_KEY, upsertStoredEntity(rules, nextRule));

  return nextRule;
}

export async function listMapRules(input?: {
  mode?: MapRule["mode"];
  workspaceId?: string;
}): Promise<MapRule[]> {
  const workspaceId = input?.workspaceId ?? DEFAULT_WORKSPACE_ID;

  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_map_rules", {
        input: {
          workspaceId,
          ...(input?.mode ? { mode: input.mode } : {}),
        },
      });

      return parseMapRules(payload);
    } catch (error) {
      reportCommandFailure("list_map_rules", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return readStoredRules(MAP_RULES_STORAGE_KEY, parseMapRules).filter((rule) => {
    if (rule.workspaceId !== workspaceId) {
      return false;
    }

    return input?.mode ? rule.mode === input.mode : true;
  });
}

export async function saveMapRule(input: Omit<MapRule, "id"> & { id?: string }): Promise<MapRule> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("save_map_rule", {
        input,
      });

      const [savedRule] = parseMapRules([payload]);
      return savedRule!;
    } catch (error) {
      reportCommandFailure("save_map_rule", error, input.workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const rules = readStoredRules(MAP_RULES_STORAGE_KEY, parseMapRules);
  const nextRule = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as MapRule;

  writeStoredRules(MAP_RULES_STORAGE_KEY, upsertStoredEntity(rules, nextRule));

  return nextRule;
}

export async function listScriptRules(workspaceId = DEFAULT_WORKSPACE_ID): Promise<ScriptRule[]> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_script_rules", {
        input: { workspaceId },
      });

      return parseScriptRules(payload);
    } catch (error) {
      reportCommandFailure("list_script_rules", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return readStoredRules(SCRIPT_RULES_STORAGE_KEY, parseScriptRules).filter(
    (rule) => rule.workspaceId === workspaceId,
  );
}

export async function saveScriptRule(
  input: Omit<ScriptRule, "id"> & { id?: string },
): Promise<ScriptRule> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("save_script_rule", { input });
      const [savedRule] = parseScriptRules([payload]);
      return savedRule!;
    } catch (error) {
      reportCommandFailure("save_script_rule", error, input.workspaceId);

      // L4: fall back to localStorage on a missing/unregistered command, the
      // same as every sibling save* rule wrapper. Previously this threw in
      // dev/web contexts while rewrite/map/dns/throttle rules persisted fine.
      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const rules = readStoredRules(SCRIPT_RULES_STORAGE_KEY, parseScriptRules);
  const nextRule = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as ScriptRule;

  writeStoredRules(SCRIPT_RULES_STORAGE_KEY, upsertStoredEntity(rules, nextRule));
  return nextRule;
}

/**
 * H10 (closed): the backend owns the OS file dialog. The renderer supplies only
 * a localized dialog title — never a path — and the Rust side drives the picker,
 * reads the chosen file, and returns its contents. This removes the
 * arbitrary-file-read primitive entirely: a compromised renderer can trigger the
 * dialog but cannot inject a path, because the picker result never crosses the
 * IPC boundary as input. Returns `null` when the user cancels the dialog.
 */
export async function pickAndReadScriptFile(title: string): Promise<ScriptSourceFile | null> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Picking script files requires the Tauri desktop runtime.",
    };
  }

  try {
    const payload = await invoke<unknown>("pick_and_read_script_file", {
      input: { title },
    });
    if (payload == null) {
      return null;
    }
    return parseScriptSourceFile(payload);
  } catch (error) {
    reportCommandFailure("pick_and_read_script_file", error, title);
    throw coerceAppError(error);
  }
}

export async function listScriptSessionTrace(sessionId: string): Promise<ScriptSessionTrace[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  try {
    const payload = await invoke<unknown>("list_script_session_trace", {
      input: { sessionId },
    });
    return parseScriptSessionTrace(payload);
  } catch (error) {
    reportCommandFailure("list_script_session_trace", error, sessionId);
    throw coerceAppError(error);
  }
}

export async function listRewriteSessionTrace(sessionId: string): Promise<RewriteSessionTrace[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  try {
    const payload = await invoke<unknown>("list_rewrite_session_trace", {
      input: { sessionId },
    });
    return parseRewriteSessionTrace(payload);
  } catch (error) {
    reportCommandFailure("list_rewrite_session_trace", error, sessionId);
    throw coerceAppError(error);
  }
}

export async function listMapSessionTrace(sessionId: string): Promise<MapSessionTrace[]> {
  const importedDetail = getImportedSessionDetail(sessionId);
  if (importedDetail?.mapTraces) {
    return importedDetail.mapTraces;
  }

  if (!isTauriRuntime()) {
    return [];
  }

  try {
    const payload = await invoke<unknown>("list_map_session_trace", {
      input: { sessionId },
    });
    return parseMapSessionTrace(payload);
  } catch (error) {
    reportCommandFailure("list_map_session_trace", error, sessionId);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// DNS Mappings
// ---------------------------------------------------------------------------

export async function listDnsMappings(input: { workspaceId: string }): Promise<DnsMappingRule[]> {
  if (isTauriRuntime()) {
    try {
      const result = await invoke("list_dns_mappings", { input });
      return parseDnsMappings(result);
    } catch (error) {
      reportCommandFailure("list_dns_mappings", error);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return readStoredRules(DNS_MAPPINGS_STORAGE_KEY, parseDnsMappings).filter(
    (rule) => rule.workspaceId === input.workspaceId,
  );
}

export async function saveDnsMapping(
  input: Omit<DnsMappingRule, "id"> & { id?: string },
): Promise<DnsMappingRule> {
  if (isTauriRuntime()) {
    try {
      const result = await invoke("save_dns_mapping", { input });
      const parsed = parseDnsMappings([result]);
      if (parsed.length === 0) throw coerceAppError("empty result from save_dns_mapping");
      return parsed[0]!;
    } catch (error) {
      reportCommandFailure("save_dns_mapping", error);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const rules = readStoredRules(DNS_MAPPINGS_STORAGE_KEY, parseDnsMappings);
  const nextRule = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as DnsMappingRule;

  writeStoredRules(DNS_MAPPINGS_STORAGE_KEY, upsertStoredEntity(rules, nextRule));

  return nextRule;
}

export async function deleteRule(input: {
  ruleId: string;
  ruleType: "rewrite" | "map" | "dns" | "script";
}): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await invoke("delete_rule", {
        input,
      });
      return;
    } catch (error) {
      reportCommandFailure("delete_rule", error);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  if (input.ruleType === "rewrite") {
    writeStoredRules(
      REWRITE_RULES_STORAGE_KEY,
      readStoredRules(REWRITE_RULES_STORAGE_KEY, parseRewriteRules).filter(
        (rule) => rule.id !== input.ruleId,
      ),
    );
    return;
  }

  if (input.ruleType === "dns") {
    writeStoredRules(
      DNS_MAPPINGS_STORAGE_KEY,
      readStoredRules(DNS_MAPPINGS_STORAGE_KEY, parseDnsMappings).filter(
        (rule) => rule.id !== input.ruleId,
      ),
    );
    return;
  }

  if (input.ruleType === "script") {
    writeStoredRules(
      SCRIPT_RULES_STORAGE_KEY,
      readStoredRules(SCRIPT_RULES_STORAGE_KEY, parseScriptRules).filter(
        (rule) => rule.id !== input.ruleId,
      ),
    );
    return;
  }

  writeStoredRules(
    MAP_RULES_STORAGE_KEY,
    readStoredRules(MAP_RULES_STORAGE_KEY, parseMapRules).filter(
      (rule) => rule.id !== input.ruleId,
    ),
  );
}
