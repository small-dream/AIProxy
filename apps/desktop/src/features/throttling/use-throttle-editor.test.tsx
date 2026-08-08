import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThrottleProfile, ThrottleRule } from "@aiproxy/shared-types";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// M23: setActiveMutation.mutate is exposed via a holder so the temporary-
// enable test can assert whether the timeout callback deactivated the profile.
const setActiveMutateMock = vi.fn();
vi.mock("./use-throttle-profiles", () => ({
  useThrottleProfiles: () => ({ data: profilesState.current, isError: false }),
  useThrottleRules: () => ({ data: rulesState.current, isError: false }),
  useThrottleRuntimeStats: () => ({ data: undefined }),
  useSaveThrottleProfile: () => ({ mutate: vi.fn() }),
  useSaveThrottleRule: () => ({ mutate: vi.fn() }),
  useDeleteThrottleRule: () => ({ mutate: vi.fn() }),
  useSetActiveThrottleProfile: () => ({ mutate: setActiveMutateMock }),
}));

// The hook reads router location state for the "seed" feature at the top
// level — stub it so renderHook doesn't need a router provider.
const mockLocation = { pathname: "/throttling", search: "", hash: "", state: null, key: "test" };
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
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

beforeEach(() => {
  resetFixtures();
  setActiveMutateMock.mockReset();
});

describe("useThrottleEditor draft sync (H1/H2)", () => {
  it("does not overwrite an edited rule draft when rules refetch with a new array identity (H1)", () => {
    const { result, rerender } = renderHook(() => useThrottleEditor(), {
      wrapper: createWrapper(),
    });

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

  it("handleNewProfile selects the new empty profile draft and is not immediately overwritten", () => {
    // Start with no server profiles so the auto-select effect can't fight the
    // new draft; this isolates the handleNewProfile action under test.
    profilesState.current = [];

    const { result } = renderHook(() => useThrottleEditor(), {
      wrapper: createWrapper(),
    });

    act(() => result.current.handleNewProfile());

    // Selection moved to the freshly-minted draft id, and the draft is that
    // new empty profile — not a previously-selected server profile.
    expect(result.current.selectedProfileId).toBe(result.current.profileDraft?.id);
    expect(result.current.profileDraft?.name).toBe("");
    expect(result.current.profileDraft?.preset).toBe(false);
    expect(result.current.profileDraft?.enabled).toBe(false);

    // The new empty draft survives — lastSyncedProfileIdRef was set to the new
    // id (mirroring handleNewRule), so the profile-sync effect early-returns
    // and does not clobber the in-flight empty draft.
    expect(result.current.profileDraft?.id).toBe(result.current.selectedProfileId);
  });
});

describe("useThrottleEditor temporary-enable timeout (M23)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT disable a profile the user switched to after a temporary-enable on a different profile", () => {
    // M23: temporarily enabling profile A then manually activating profile B
    // must not let A's 15-minute timer later disable B. The timeout callback
    // checks the current active profile id against the one that was temporarily
    // enabled and skips the deactivate call if they differ.
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
      {
        id: "p2",
        name: "P2",
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

    const { result, rerender } = renderHook(() => useThrottleEditor(), {
      wrapper: createWrapper(),
    });

    // Temporarily enable p1 (selectedProfileId defaults to nothing, so this
    // also drives the selection).
    act(() => result.current.handleTemporaryEnable());
    // The mutate mock records the temporary-enable activation of p1.
    expect(setActiveMutateMock).toHaveBeenCalledWith("p1");

    // Simulate the user manually activating p2 (the real mutation would flip
    // enabled in profilesState; we mirror that so activeProfile resolves to p2).
    act(() => {
      profilesState.current = [
        { ...profilesState.current[0]!, enabled: false },
        { ...profilesState.current[1]!, enabled: true },
      ];
    });
    rerender();

    // Fast-forward past the full TEMP_ENABLE_MS window. The timer must NOT
    // call mutate(undefined) — that would silently disable the user's new
    // active profile p2.
    act(() => {
      vi.advanceTimersByTime(16 * 60 * 1000);
    });

    // No deactivate call should have fired after the switch.
    expect(setActiveMutateMock).not.toHaveBeenCalledWith(undefined);
  });

  it("DOES disable the profile when it is still the active one at timeout", () => {
    // M23 baseline: the guard must not BREAK the normal temporary-enable
    // behavior — when the user has NOT switched profiles, the timer still
    // deactivates.
    const { result, rerender } = renderHook(() => useThrottleEditor(), {
      wrapper: createWrapper(),
    });

    act(() => result.current.handleTemporaryEnable());
    expect(setActiveMutateMock).toHaveBeenCalledWith("p1");

    // p1 becomes the active profile (the temporary-enable activation). The
    // rerender lets the activeProfileIdRef-sync effect pick up the new value.
    act(() => {
      profilesState.current = [{ ...profilesState.current[0]!, enabled: true }];
    });
    rerender();

    act(() => {
      vi.advanceTimersByTime(16 * 60 * 1000);
    });

    expect(setActiveMutateMock).toHaveBeenCalledWith(undefined);
  });
});
