export function readStorageValue(key: string): string | null {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return null;
  }

  return window.localStorage.getItem(key);
}

export function writeStorageValue(key: string, value: string) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  window.localStorage.setItem(key, value);
}

export function removeStorageValue(key: string) {
  if (typeof window === "undefined" || typeof window.localStorage?.removeItem !== "function") {
    return;
  }

  window.localStorage.removeItem(key);
}

export function normalizeStoredHost(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalizedValue = value.trim();

  return normalizedValue.length > 0 ? normalizedValue : null;
}

export function readStoredHosts(key: string): string[] {
  const rawValue = readStorageValue(key);

  if (!rawValue) {
    return [];
  }

  try {
    const parsedValue = JSON.parse(rawValue);

    if (!Array.isArray(parsedValue)) {
      return [];
    }

    return Array.from(
      new Set(
        parsedValue
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    );
  } catch {
    return [];
  }
}

export function guessExtension(mimeType: string): string {
  if (mimeType.includes("json")) return "json";
  if (mimeType.includes("html")) return "html";
  if (mimeType.includes("xml")) return "xml";
  if (mimeType.includes("javascript")) return "js";
  if (mimeType.includes("css")) return "css";
  if (mimeType.includes("text")) return "txt";
  if (mimeType.includes("image/png")) return "png";
  if (mimeType.includes("image/jpeg") || mimeType.includes("image/jpg")) return "jpg";
  if (mimeType.includes("image/svg")) return "svg";
  if (mimeType.includes("image/gif")) return "gif";
  if (mimeType.includes("image/")) return "bin";
  return "txt";
}
