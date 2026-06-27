import { useCallback, useEffect, useRef } from "react";

import type { VariableRow } from "@/features/environments/components/VariableEditorTable";

// H8: switching the selected environment must flush the previous environment's
// pending debounced variable save. A naive debouncer holds the latest edits in
// a setTimeout; when the user switches env and edits env B, env B's first edit
// calls clearTimeout() on the SAME timer ref and silently drops env A's edit.
//
// This hook owns the debounce timer + the latest (envId, variables) snapshot so
// an env switch can flush the previous env immediately. It is extracted from
// EnvironmentManagerDialog so the flush behavior is unit-testable without the
// MUI <Dialog> render path.

const SAVE_DEBOUNCE_MS = 500;

export interface SaveEnvVarsInput {
  environmentId: string;
  variables: Array<{
    id: string;
    key: string;
    value: string;
    enabled: boolean;
    sortOrder?: number;
  }>;
}

export interface UseEnvVarsSaveManagerArgs {
  selectedEnvId: string | null;
  save: (input: SaveEnvVarsInput) => void;
}

interface PendingSave {
  envId: string;
  variables: VariableRow[];
}

/**
 * Map editor rows to the persisted variable shape, reassigning sortOrder to a
 * stable 0..n sequence (matches the inline mapping in the dialog).
 */
function toSaveVariables(variables: VariableRow[]) {
  return variables.map((v, i) => ({
    id: v.id,
    key: v.key,
    value: v.value,
    enabled: v.enabled,
    sortOrder: i,
  }));
}

export function useEnvVarsSaveManager({
  selectedEnvId,
  save,
}: UseEnvVarsSaveManagerArgs) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest pending snapshot so an env switch can flush the previous env.
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const prevEnvIdRef = useRef<string | null>(selectedEnvId);

  // Keep the latest save in a ref (updated in an effect, not during render)
  // so scheduleSave/flush stay identity-stable without listing `save` as a
  // dependency that would reset the debounced timer on every render.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // Flush the pending env save immediately (clearing the timer).
  const flush = useCallback(() => {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    saveRef.current({
      environmentId: pending.envId,
      variables: toSaveVariables(pending.variables),
    });
    pendingSaveRef.current = null;
  }, []);

  // Flush when the selected env changes (H8).
  useEffect(() => {
    if (prevEnvIdRef.current !== selectedEnvId) {
      flush();
      prevEnvIdRef.current = selectedEnvId;
    }
  }, [selectedEnvId, flush]);

  // Clear any pending timer on unmount (M9 "ghost save").
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Schedule a debounced save for the currently selected env.
  const scheduleSave = useCallback(
    (variables: VariableRow[]) => {
      if (!selectedEnvId) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      pendingSaveRef.current = { envId: selectedEnvId, variables };
      timeoutRef.current = setTimeout(() => {
        const pending = pendingSaveRef.current;
        if (pending) {
          saveRef.current({
            environmentId: pending.envId,
            variables: toSaveVariables(pending.variables),
          });
          pendingSaveRef.current = null;
        }
        timeoutRef.current = null;
      }, SAVE_DEBOUNCE_MS);
    },
    [selectedEnvId],
  );

  return { scheduleSave, flush };
}
