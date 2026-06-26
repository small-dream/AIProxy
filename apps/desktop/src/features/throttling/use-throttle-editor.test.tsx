import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThrottleProfile, ThrottleRule } from "@aiproxy/shared-types";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useThrottleEditor } from "./use-throttle-editor";

// --- Mock data with controllable identity ---
const rulesState: { current: ThrottleRule[] } = {
  current: [
    {
      id: "r1",
      name: "R1",
      profileId: "p1",
      urlPattern: "*",
      enabled: true,
      priority: 100,
      methods: [],
      stage: "both",
      note: "",
      workspaceId: "default",
    },
  ],
};
const profilesState: { current: ThrottleProfile[] } = {
  current: [
    {
      id: "p1",
      name: "P1",
      workspaceId: "default",
      latencyMs: 0,
      uploadKbps: 1,
      downloadKbps: 1,
      packetLossRatio: 0,
      enabled: false,
      preset: false,
      note: "",
    },
  ],
};

// Mock the query/mutation hooks so we control array identity exactly.
vi.mock("./use-throttle-profiles", () => ({
  useThrottleProfiles: () => ({ data: profilesState.current, isError: false }),
  useThrottleRules: () => ({ data: rulesState.current, isError: false }),
  useThrottleRuntimeStats: () => ({ data: undefined }),
  useSaveThrottleProfile: () => ({ mutate: vi.fn() }),
  useSaveThrottleRule: () => ({ mutate: vi.fn() }),
  useDeleteThrottleRule: () => ({ mutate: vi.fn() }),
  useSetActiveThrottleProfile: () => ({ mutate: vi.fn() }),
}));

// The hook reads router location state for the "seed" feature at the top
// level — stub it so renderHook doesn't need a router provider.
const mockLocation = { pathname: "/throttling", search: "", hash: "", state: null, key: "test" };
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useLocation: () => mockLocation,
  };
});

// Keep the test free of the i18n provider / preference store dependency.
vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, tList: (key: string) => [key], locale: "en-US" }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function resetFixtures() {
  rulesState.current = [
    {
      id: "r1",
      name: "R1",
      profileId: "p1",
      urlPattern: "*",
      enabled: true,
      priority: 100,
      methods: [],
      stage: "both",
      note: "",
      workspaceId: "default",
    },
  ];
  profilesState.current = [
    {
      id: "p1",
      name: "P1",
      workspaceId: "default",
      latencyMs: 0,
      uploadKbps: 1,
      downloadKbps: 1,
      packetLossRatio: 0,
      enabled: false,
      preset: false,
      note: "",
    },
  ];
}

beforeEach(resetFixtures);

describe("useThrottleEditor draft sync (H1/H2)", () => {
  it("does not overwrite an edited rule draft when rules refetch with a new array identity (H1)", () => {
    const { result, rerender } = renderHook(() => useThrottleEditor(), { wrapper: createWrapper() });

    // Pick r1 explicitly so a draft exists.
    const r1 = rulesState.current[0]!;
    act(() => result.current.selectRule(r1));
    expect(result.current.ruleDraft?.id).toBe("r1");

    // Edit the name via the existing patch action.
    act(() => result.current.updateRuleDraft({ name: "EDITED" }));
    expect(result.current.ruleDraft?.name).toBe("EDITED");

    // Simulate a TanStack Query refetch: brand-new array AND object identity,
    // same id. Previously this clobbered the in-flight edit.
    act(() => {
      rulesState.current = [{ ...r1, name: "R1" }];
    });

    // Force a re-render so the mocked useThrottleRules re-runs and returns the
    // new array identity. Without this the mock never re-executes (mutating the
    // module-level rulesState.current alone triggers no React state change), the
    // sync effect never sees the new identity, and the refetch path would go
    // untested — so do NOT remove this rerender() call.
    act(() => rerender());

    // The ref-based sync must early-return on same id and NOT overwrite the
    // edit. Draft must stay edited despite the new server array identity.
    expect(result.current.ruleDraft?.name).toBe("EDITED");
  });

  it("duplicateRule selects the new rule id so the copy survives (H2)", () => {
    const { result } = renderHook(() => useThrottleEditor(), { wrapper: createWrapper() });

    const r1 = rulesState.current[0]!;
    act(() => result.current.selectRule(r1));
    const before = result.current.ruleDraft!.id;

    act(() => result.current.duplicateRule(result.current.ruleDraft!));

    // Both the selection and the draft must move to the new (copied) id,
    // otherwise the sync effect would immediately revert the copy.
    expect(result.current.selectedRuleId).not.toBe(before);
    expect(result.current.ruleDraft?.id).not.toBe(before);
    expect(result.current.ruleDraft?.name).toContain("copy");
  });
});
