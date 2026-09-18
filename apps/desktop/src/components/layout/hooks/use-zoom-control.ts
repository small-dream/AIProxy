import { useEffect, useState } from "react";

const ZOOM_STORAGE_KEY = "aiproxy.shell.zoom-level";

function readInitialZoomLevel() {
  if (typeof window === "undefined") {
    return 1;
  }
  const raw = window.localStorage.getItem(ZOOM_STORAGE_KEY);
  const value = raw ? Number.parseFloat(raw) : 1;
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0.5), 2);
}

/**
 * Manages zoom level state and listens for zoom keyboard/menu events.
 * Applies zoom to the document root element.
 */
export function useZoomControl() {
  const [zoomLevel, setZoomLevel] = useState(readInitialZoomLevel);

  useEffect(() => {
    const root = document.documentElement;
    root.style.zoom = String(zoomLevel);
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(zoomLevel));
  }, [zoomLevel]);

  useEffect(() => {
    function handleZoomIn() {
      // Round to the 0.1 grid: repeated ±0.1 float steps otherwise accumulate
      // error (1 + 0.1×3 → 1.3000000000000003) and drift off the presets.
      setZoomLevel((prev) => Math.min(Math.round((prev + 0.1) * 10) / 10, 2));
    }
    function handleZoomOut() {
      setZoomLevel((prev) => Math.max(Math.round((prev - 0.1) * 10) / 10, 0.5));
    }
    function handleZoomReset() {
      setZoomLevel(1);
    }

    window.addEventListener("aiproxy-menu-zoom-in", handleZoomIn);
    window.addEventListener("aiproxy-menu-zoom-out", handleZoomOut);
    window.addEventListener("aiproxy-menu-zoom-reset", handleZoomReset);

    // Native-style zoom keyboard shortcuts (Cmd/Ctrl + +/−/0). The desktop
    // WebView supports `style.zoom`, but the app previously only wired up menu
    // events, so keyboard users had no zoom control (L8).
    function handleKeydown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key;
      if (key === "+" || key === "=") {
        event.preventDefault();
        handleZoomIn();
      } else if (key === "-" || key === "_") {
        event.preventDefault();
        handleZoomOut();
      } else if (key === "0") {
        event.preventDefault();
        handleZoomReset();
      }
    }
    window.addEventListener("keydown", handleKeydown);

    return () => {
      window.removeEventListener("aiproxy-menu-zoom-in", handleZoomIn);
      window.removeEventListener("aiproxy-menu-zoom-out", handleZoomOut);
      window.removeEventListener("aiproxy-menu-zoom-reset", handleZoomReset);
      window.removeEventListener("keydown", handleKeydown);
    };
  }, []);

  return { zoomLevel };
}
