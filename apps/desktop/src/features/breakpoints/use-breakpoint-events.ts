import { useEffect } from "react";
import { onBreakpointHit } from "@/services/events";
import { useBreakpointStore } from "./breakpoint.store";

export function useBreakpointEvents() {
  const addPendingHit = useBreakpointStore((s) => s.addPendingHit);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    onBreakpointHit((hit) => {
      addPendingHit(hit);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [addPendingHit]);
}
