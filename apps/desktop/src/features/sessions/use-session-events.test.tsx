import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useSessionEvents } from "./use-session-events";

function createWrapper() {
  const queryClient = new QueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

describe("useSessionEvents", () => {
  it("mounts without throwing", () => {
    const wrapper = createWrapper();
    expect(() => renderHook(() => useSessionEvents(), { wrapper })).not.toThrow();
  });
});
