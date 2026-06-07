import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_REQUEST_SPLIT_RATIO,
  clampInspectorSplitRatio,
  type RequestInspectorTab,
  type ResponseInspectorTab,
} from "@/features/sessions/components/session-inspector.helpers";
import {
  readStorageValue,
  writeStorageValue,
} from "@/features/sessions/session-ui.helpers";
import type { SessionContainer } from "@/features/sessions/session-containers.helpers";

const EXPLORER_WIDTH_STORAGE_KEY = "aiproxy.sessions.explorerWidth";
const EXPANDED_HOSTS_STORAGE_KEY = "aiproxy.sessions.expandedHosts";
const INSPECTOR_SPLIT_RATIO_STORAGE_KEY = "aiproxy.sessions.inspectorSplitRatio";
const REQUEST_COLLAPSED_STORAGE_KEY = "aiproxy.sessions.requestCollapsed";
const SELECTED_SESSION_ID_STORAGE_KEY = "aiproxy.sessions.selectedSessionId";

export function clampExplorerWidth(width: number) {
  return Math.min(520, Math.max(280, Math.round(width)));
}

export interface SessionExplorerLayoutState {
  explorerWidth: number;
  defaultInspectorSplitRatio: number;
  explorerDragFrameRef: React.RefObject<number | null>;
  inspectorDragFrameRef: React.RefObject<number | null>;
  startExplorerResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  startInspectorResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleInspectorSplitRatioChange: (ratio: number) => void;
  handleRequestCollapsedChange: (collapsed: boolean) => void;
  handleDomainFilterChange: (value: string) => void;
  handleRequestTabChange: (tab: RequestInspectorTab) => void;
  handleResponseTabChange: (tab: ResponseInspectorTab) => void;
}

export interface UseSessionExplorerLayoutParams {
  updateContainer: (updater: (container: SessionContainer) => SessionContainer) => void;
  requestCollapsed: boolean;
  /** Storage key exports for the parent to use in persistence effects */
}

export function useSessionExplorerLayout({
  updateContainer,
  requestCollapsed,
}: UseSessionExplorerLayoutParams): SessionExplorerLayoutState {
  const explorerDragFrameRef = useRef<number | null>(null);
  const inspectorDragFrameRef = useRef<number | null>(null);

  const defaultInspectorSplitRatio = useMemo(() => {
    const savedRatio = Number(readStorageValue(INSPECTOR_SPLIT_RATIO_STORAGE_KEY));
    return Number.isFinite(savedRatio)
      ? clampInspectorSplitRatio(savedRatio)
      : DEFAULT_REQUEST_SPLIT_RATIO;
  }, []);

  const [explorerWidth, setExplorerWidth] = useState(() => {
    const savedWidth = readStorageValue(EXPLORER_WIDTH_STORAGE_KEY);
    const parsedWidth = Number(savedWidth);
    return Number.isFinite(parsedWidth) ? clampExplorerWidth(parsedWidth) : 360;
  });

  const handleInspectorSplitRatioChange = useCallback(
    (ratio: number) => {
      updateContainer((container: SessionContainer) => ({
        ...container,
        inspectorSplitRatio: ratio,
      }));
    },
    [updateContainer],
  );

  const handleRequestCollapsedChange = useCallback(
    (collapsed: boolean) => {
      updateContainer((container: SessionContainer) => ({
        ...container,
        requestCollapsed: collapsed,
      }));
    },
    [updateContainer],
  );

  const handleDomainFilterChange = useCallback(
    (value: string) => {
      updateContainer((container: SessionContainer) => ({
        ...container,
        domainFilterValue: value,
      }));
    },
    [updateContainer],
  );

  const handleRequestTabChange = useCallback(
    (tab: RequestInspectorTab) => {
      updateContainer((container: SessionContainer) => ({
        ...container,
        requestTab: tab,
      }));
    },
    [updateContainer],
  );

  const handleResponseTabChange = useCallback(
    (tab: ResponseInspectorTab) => {
      updateContainer((container: SessionContainer) => ({
        ...container,
        responseTab: tab,
      }));
    },
    [updateContainer],
  );

  function startExplorerResize(event: ReactPointerEvent<HTMLDivElement>) {
    const container = event.currentTarget.parentElement;
    if (!container) return;

    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const updateWidth = (clientX: number) => {
      const bounds = container.getBoundingClientRect();
      const nextWidth = clampExplorerWidth(clientX - bounds.left);
      if (explorerDragFrameRef.current) {
        window.cancelAnimationFrame(explorerDragFrameRef.current);
      }
      explorerDragFrameRef.current = window.requestAnimationFrame(() => {
        setExplorerWidth(nextWidth);
      });
    };

    updateWidth(event.clientX);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  const startInspectorResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = event.currentTarget.parentElement;
      if (!container || requestCollapsed) return;

      event.preventDefault();
      const pointerId = event.pointerId;
      event.currentTarget.setPointerCapture(pointerId);

      const updateRatio = (clientY: number) => {
        const bounds = container.getBoundingClientRect();
        if (bounds.height <= 0) return;

        const nextRatio = clampInspectorSplitRatio((clientY - bounds.top) / bounds.height);
        if (inspectorDragFrameRef.current) {
          window.cancelAnimationFrame(inspectorDragFrameRef.current);
        }
        inspectorDragFrameRef.current = window.requestAnimationFrame(() => {
          handleInspectorSplitRatioChange(nextRatio);
        });
      };

      updateRatio(event.clientY);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        updateRatio(moveEvent.clientY);
      };

      const stopResize = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
    },
    [requestCollapsed, handleInspectorSplitRatioChange],
  );

  // Persist explorer width to localStorage
  useEffect(() => {
    writeStorageValue(EXPLORER_WIDTH_STORAGE_KEY, String(explorerWidth));
  }, [explorerWidth]);

  // Cleanup animation frames on unmount
  useEffect(() => {
    return () => {
      if (explorerDragFrameRef.current) {
        window.cancelAnimationFrame(explorerDragFrameRef.current);
      }
      if (inspectorDragFrameRef.current) {
        window.cancelAnimationFrame(inspectorDragFrameRef.current);
      }
    };
  }, []);

  return {
    explorerWidth,
    defaultInspectorSplitRatio,
    explorerDragFrameRef,
    inspectorDragFrameRef,
    startExplorerResize,
    startInspectorResize,
    handleInspectorSplitRatioChange,
    handleRequestCollapsedChange,
    handleDomainFilterChange,
    handleRequestTabChange,
    handleResponseTabChange,
  };
}

// Re-export storage keys for the page component to use in persistence effects
export {
  EXPLORER_WIDTH_STORAGE_KEY,
  EXPANDED_HOSTS_STORAGE_KEY,
  INSPECTOR_SPLIT_RATIO_STORAGE_KEY,
  REQUEST_COLLAPSED_STORAGE_KEY,
  SELECTED_SESSION_ID_STORAGE_KEY,
};

// Re-export from use-session-filters for the page component
export { FOCUSED_HOSTS_STORAGE_KEY } from "./use-session-filters";
