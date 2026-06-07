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

    return () => {
      window.removeEventListener("aiproxy-menu-zoom-in", handleZoomIn);
      window.removeEventListener("aiproxy-menu-zoom-out", handleZoomOut);
      window.removeEventListener("aiproxy-menu-zoom-reset", handleZoomReset);
    };
  }, []);

  return { zoomLevel };
}
