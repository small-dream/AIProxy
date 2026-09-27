import { useCallback, useEffect, useRef, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router-dom";

/**
 * Shared unsaved-changes guard (P0-2). Covers the two ways edits are lost
 * silently:
 * - route navigation away from the page → intercepted with `useBlocker`
 * - in-component transitions that replace or discard the draft (selecting
 *   another rule, switching workbench tabs, …) → `confirmLeave()`
 *
 * The hook owns a single dialog decision: both paths funnel into one open
 * state so only one confirmation is ever visible. Render the ConfirmDialog
 * from the returned props at the call site:
 *
 * ```tsx
 * const guard = useUnsavedChangesGuard(isDirty);
 * <ConfirmDialog
 *   confirmColor="warning"
 *   confirmLabel={t("common.actions.discard")}
 *   message={t("...unsavedChangesMessage")}
 *   onCancel={guard.handleCancel}
 *   onConfirm={guard.handleConfirm}
 *   open={guard.dialogOpen}
 *   title={t("...unsavedChangesTitle")}
 * />
 * ```
 */
export function useUnsavedChangesGuard(isDirty: boolean) {
  // The beforeunload handler and confirmLeave run outside render, so they read
  // dirtiness through a ref to stay stable across renders. The sync itself
  // must live in an effect — writing refs during render is not allowed.
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  // In-component transition: resolves true when leaving is allowed.
  const [decision, setDecision] = useState<((allowed: boolean) => void) | undefined>();
  // Mirror of the pending resolver, writable outside render. Lets confirmLeave
  // settle a superseded promise on re-entry and the unmount cleanup settle a
  // promise that would otherwise stay pending forever.
  const decisionRef = useRef<((allowed: boolean) => void) | undefined>(undefined);

  const blocker = useBlocker(isDirty);

  useBeforeUnload(
    useCallback((event: BeforeUnloadEvent) => {
      if (isDirtyRef.current) {
        event.preventDefault();
      }
    }, []),
  );

  // Unmounting with a pending confirmation must not leak the promise.
  useEffect(() => {
    return () => {
      decisionRef.current?.(false);
      decisionRef.current = undefined;
    };
  }, []);

  const confirmLeave = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        if (!isDirtyRef.current) {
          resolve(true);
          return;
        }
        // Re-entrant call: settle the superseded promise instead of leaving it
        // pending forever — only one confirmation can be visible at a time.
        decisionRef.current?.(false);
        decisionRef.current = resolve;
        setDecision(() => resolve);
      }),
    [],
  );

  const handleConfirm = useCallback(() => {
    decision?.(true);
    decisionRef.current = undefined;
    setDecision(undefined);
    if (blocker.state === "blocked") {
      blocker.proceed();
    }
  }, [blocker, decision]);

  const handleCancel = useCallback(() => {
    decision?.(false);
    decisionRef.current = undefined;
    setDecision(undefined);
    if (blocker.state === "blocked") {
      blocker.reset();
    }
  }, [blocker, decision]);

  return {
    isDirty,
    confirmLeave,
    dialogOpen: decision !== undefined || blocker.state === "blocked",
    handleCancel,
    handleConfirm,
  };
}
