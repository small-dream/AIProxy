import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEnvVarsSaveManager } from "./use-env-vars-save-manager";

// H8: switching the selected environment must flush the previous environment's
// pending debounced variable save, instead of letting the new environment's
// first edit clearTimeout() the pending timer and silently drop the edit.
//
// The full EnvironmentManagerDialog renders an MUI <Dialog> whose
// Portal/focus-trap/CSS-transition hangs under this repo's jsdom + vitest
// config (verified: even a bare render of the dialog never resolves). The
// flush-on-switch behavior is owned by useEnvVarsSaveManager, extracted from
// the dialog precisely so it can be unit-tested. This test locks the behavior.

function row(key: string, value = "V", id = `${key}-id`) {
  return { id, key, value, enabled: true, sortOrder: 0 };
}

describe("useEnvVarsSaveManager (H8 flush-on-switch)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes pending edits to the previous env when switching (does not drop them)", () => {
    const save = vi.fn();
    const { result, rerender } = renderHook(
      ({ envId }: { envId: string | null }) =>
        useEnvVarsSaveManager({ selectedEnvId: envId, save }),
      { initialProps: { envId: "envA" as string | null } },
    );

    // Edit env A: schedules a 500ms debounced save (timer held, NOT fired).
    act(() => {
      result.current.scheduleSave([row("EDITED_KEY")]);
    });
    expect(save).not.toHaveBeenCalled();

    // Switch to env B BEFORE the 500ms timer fires.
    act(() => {
      rerender({ envId: "envB" });
    });

    // Flushing on switch must have saved env A's pending edit immediately.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "envA" }),
    );
    const saved = save.mock.calls[0]![0] as {
      environmentId: string;
      variables: Array<{ key: string }>;
    };
    expect(saved.variables.some((v) => v.key === "EDITED_KEY")).toBe(true);
  });

  it("does not flush when there is no pending edit (switching without editing)", () => {
    const save = vi.fn();
    const { rerender } = renderHook(
      ({ envId }: { envId: string | null }) =>
        useEnvVarsSaveManager({ selectedEnvId: envId, save }),
      { initialProps: { envId: "envA" as string | null } },
    );

    // Switch without ever scheduling a save for env A.
    act(() => {
      rerender({ envId: "envB" });
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("fires the debounced save after the timer when the env is not switched", () => {
    const save = vi.fn();
    const { result } = renderHook(() =>
      useEnvVarsSaveManager({ selectedEnvId: "envA", save }),
    );

    act(() => {
      result.current.scheduleSave([row("K", "V1")]);
    });
    expect(save).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "envA" }),
    );
  });

  it("does not double-save (flush then expired timer must not fire again)", () => {
    const save = vi.fn();
    const { result, rerender } = renderHook(
      ({ envId }: { envId: string | null }) =>
        useEnvVarsSaveManager({ selectedEnvId: envId, save }),
      { initialProps: { envId: "envA" as string | null } },
    );

    act(() => {
      result.current.scheduleSave([row("K")]);
    });
    // Switch (flush) then let the original timer's time elapse.
    act(() => {
      rerender({ envId: "envB" });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Exactly one save (the flush); the cleared timer must not fire again.
    expect(save).toHaveBeenCalledTimes(1);
  });
});
