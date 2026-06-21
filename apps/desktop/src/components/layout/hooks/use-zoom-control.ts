import { useEffect, useState } from "react";

/**
 * Manages zoom level state and listens for zoom keyboard/menu events.
 * Applies zoom to the document root element.
 */
export function useZoomControl() {
  const [zoomLevel, setZoomLevel] = useState(1);

  useEffect(() => {
    const root = document.documentElement;
    root.style.zoom = String(zoomLevel);
  }, [zoomLevel]);

  useEffect(() => {
    function handleZoomIn() {
      setZoomLevel((prev) => Math.min(prev + 0.1, 2));
    }
    function handleZoomOut() {
      setZoomLevel((prev) => Math.max(prev - 0.1, 0.5));
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
