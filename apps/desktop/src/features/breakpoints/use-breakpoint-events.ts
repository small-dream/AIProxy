import { useEffect } from "react";
import { onBreakpointHit } from "@/services/events";
import { useBreakpointStore } from "./breakpoint.store";

export function useBreakpointEvents() {
  const addPendingHit = useBreakpointStore((s) => s.addPendingHit);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    onBreakpointHit((hit) => {
      if (cancelled) return;
      addPendingHit(hit);
    }).then((fn) => {
      if (!cancelled) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addPendingHit]);
}
