// Typed react-query `meta` for queries and mutations whose errors are handled
// intentionally by the caller and must NOT surface as a global notification.
// Consumed by the global QueryCache.onError / MutationCache.onError handlers in
// AppProviders.tsx. Query example: the mobile device probes (adb / hdc / iOS
// Simulator) fail quietly when the toolchain is absent and only surface errors
// in-panel on an explicit user refresh. Mutation example: the certificates page
// pushes its own localized error notification and suppresses the fallback.
export {};

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      suppressGlobalErrorNotification?: boolean;
    };
    mutationMeta: {
      suppressGlobalErrorNotification?: boolean;
    };
  }
}
