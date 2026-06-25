// Typed react-query `meta` for queries whose errors are handled intentionally
// by the caller and must NOT surface as a global notification. Consumed by the
// global QueryCache.onError in AppProviders.tsx. Example: the mobile device
// probes (adb / hdc / iOS Simulator) fail quietly when the toolchain is absent
// and only surface errors in-panel on an explicit user refresh.
export {};

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      suppressGlobalErrorNotification?: boolean;
    };
  }
}
