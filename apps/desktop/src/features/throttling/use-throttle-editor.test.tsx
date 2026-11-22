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
// N-1: saveProfileMutation.mutate likewise, so the save path can be driven
// with a controlled onSuccess.
const setActiveMutateMock = vi.fn();
const saveProfileMutateMock = vi.fn();
vi.mock("./use-throttle-profiles", () => ({
  useThrottleProfiles: () => ({ data: profilesState.current, isError: false }),
  useThrottleRules: () => ({ data: rulesState.current, isError: false }),
  useThrottleRuntimeStats: () => ({ data: undefined }),
  useSaveThrottleProfile: () => ({ mutate: saveProfileMutateMock }),
  useSaveThrottleRule: () => ({ mutate: vi.fn() }),
  useDeleteThrottleRule: () => ({ mutate: vi.fn() }),
  useSetActiveThrottleProfile: () => ({ mutate: setActiveMutateMock }),
}));

// The hook reads router location state for the "seed" feature at the top
// level — stub it so renderHook doesn't need a router provider.
const mockLocation: {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
  key: string;
} = { pathname: "/throttling", search: "", hash: "", state: null, key: "test" };
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useLocation: () => mockLocation,
  };
});

// Keep the test free of the i18n provider / preference store dependency. The
// mock records calls so tests can assert rule names are built through t()
// with the right key/params instead of hardcoded English.
const tMock = vi.fn((key: string) => key);
vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: tMock, tList: (key: string) => [key], locale: "en-US" }),
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
  saveProfileMutateMock.mockReset();
  tMock.mockClear();
  mockLocation.state = null;
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

  it("duplicateRule builds the copy name through t() (throttlingPage.copySuffix)", () => {
    const { result } = renderHook(() => useThrottleEditor(), { wrapper: createWrapper() });

    act(() => result.current.selectRule(rulesState.current[0]!));
    tMock.mockClear();
    act(() => result.current.duplicateRule(result.current.ruleDraft!));

    // The duplicated rule name must come from the i18n copy-suffix template
    // (localized "… copy"), not a hardcoded "`${name} copy`" string.
    expect(tMock).toHaveBeenCalledWith("throttlingPage.copySuffix", { name: "R1" });
    expect(result.current.ruleDraft?.name).toBe("throttlingPage.copySuffix");
  });

  it("handleNewRule names the draft via t() (throttlingPage.defaultRuleName)", () => {
    const { result } = renderHook(() => useThrottleEditor(), { wrapper: createWrapper() });

    tMock.mockClear();
    act(() => result.current.handleNewRule());

    expect(tMock).toHaveBeenCalledWith("throttlingPage.defaultRuleName");
    expect(result.current.ruleDraft?.name).toBe("throttlingPage.defaultRuleName");
  });

  it("seeded rule without a method names the draft via t() (throttlingPage.anyMethod)", () => {
    mockLocation.state = { throttleSeed: { host: "example.com" } };

    const { result } = renderHook(() => useThrottleEditor(), { wrapper: createWrapper() });

    expect(tMock).toHaveBeenCalledWith("throttlingPage.anyMethod");
    expect(result.current.ruleDraft?.name).toBe("throttlingPage.anyMethod example.com");
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

  it("handleNewProfile keeps the empty draft even when profiles exist (H-1 regression)", () => {
    // Review H-1: with a non-empty profiles list (the normal steady state
    // once the user has saved anything), the auto-select effect used to
    // immediately overwrite the fresh draft with the active/first profile —
    // turning "New Custom" into an edit of that profile whose save would
    // silently upsert over its data.
    profilesState.current = [
      {
        id: "p1",
        name: "Enabled Custom",
        workspaceId: "default",
        latencyMs: 0,
        uploadKbps: 1,
        downloadKbps: 1,
        packetLossRatio: 0,
        enabled: true, // activeProfile branch of the fallback
        preset: false,
        note: "",
      },
      {
        id: "p2",
        name: "Fast 4G",
        workspaceId: "default",
        latencyMs: 0,
        uploadKbps: 1,
        downloadKbps: 1,
        packetLossRatio: 0,
        enabled: false,
        preset: true,
        note: "",
      },
    ];

    const { result, rerender } = renderHook(() => useThrottleEditor(), {
      wrapper: createWrapper(),
    });

    // Wait for the initial auto-select (mount) to settle on p1.
    expect(result.current.selectedProfileId).toBe("p1");

    act(() => result.current.handleNewProfile());

    // A refetch/rerender must NOT let the auto-select effect clobber the
    // fresh draft with the active profile (p1) or a preset (p2).
    rerender();
    rerender();

    const draft = result.current.profileDraft!;
    expect(draft.name).toBe("");
    expect(draft.preset).toBe(false);
    expect(draft.enabled).toBe(false);
    expect(result.current.selectedProfileId).toBe(draft.id);
    expect(draft.id).not.toBe("p1");
    expect(draft.id).not.toBe("p2");
    expect(
      profilesState.current.some((profile) => profile.id === draft.id),
      "the new draft id must not collide with an existing profile id",
    ).toBe(false);

    // Selecting an existing profile ends the new-draft window and restores
    // the auto-select protection for future unsaved drafts.
    act(() => result.current.selectProfile(profilesState.current[0]!));
    expect(result.current.selectedProfileId).toBe("p1");
    expect(result.current.profileDraft?.id).toBe("p1");
  });

  it("keeps the selection on the freshly saved profile (N-1 regression)", () => {
    // N-1: saving a NEW profile used to snap the selection back to the
    // previously active profile — the profiles cache is refreshed by
    // invalidate-only, so at the moment handleSaveProfile.onSuccess ran the
    // list still lacked the saved id and the auto-select effect fell back to
    // the active profile. The save mutation now writes the saved entity into
    // the cache in its mutation-level onSuccess BEFORE the per-call
    // onSuccess; this test emulates exactly that ordering.
    profilesState.current = [
      {
        id: "p1",
        name: "Enabled Custom",
        workspaceId: "default",
        latencyMs: 0,
        uploadKbps: 1,
        downloadKbps: 1,
        packetLossRatio: 0,
        enabled: true,
        preset: false,
        note: "",
      },
    ];

    const { result, rerender } = renderHook(() => useThrottleEditor(), {
      wrapper: createWrapper(),
    });
    expect(result.current.selectedProfileId).toBe("p1");

    act(() => result.current.handleNewProfile());
    act(() =>
      result.current.setProfileDraft({ ...result.current.profileDraft!, name: "Brand New" }),
    );
    act(() => result.current.handleSaveProfile());

    const call = saveProfileMutateMock.mock.calls.at(-1)!;
    const [input, options] = call as [
      ThrottleProfile,
      { onSuccess: (saved: ThrottleProfile) => void },
    ];
    const saved: ThrottleProfile = { ...input };

    act(() => {
      // Emulate the fixed mutation pipeline (N-1): the mutation-level cache
      // write happens BEFORE the per-call onSuccess, so the profiles list
      // gains the saved id in the same tick.
      profilesState.current = [...profilesState.current, saved];
      options.onSuccess(saved);
    });
    rerender();
    rerender();

    expect(result.current.selectedProfileId).toBe(saved.id);
    expect(result.current.profileDraft?.id).toBe(saved.id);
    expect(result.current.profileDraft?.name).toBe("Brand New");
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

describe("useThrottleEditor apply preset target (P0-1)", () => {
  it("enables the explicitly passed profile id, not the currently selected one", () => {
    // P0-1: clicking Apply on a preset row must activate THAT row's profile.
    // Before the fix the row's id was dropped and the hook fell back to
    // selectedProfileId, silently enabling the wrong profile.
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

    const { result } = renderHook(() => useThrottleEditor(), { wrapper: createWrapper() });

    // The user has p1 selected in the editor pane...
    act(() => result.current.selectProfile(profilesState.current[0]!));
    expect(result.current.selectedProfileId).toBe("p1");

    // ...then clicks Apply on the p2 row. The activation must target p2.
    act(() => result.current.handleTemporaryEnable("p2"));
    expect(setActiveMutateMock).toHaveBeenCalledWith("p2");
  });

  it("falls back to selectedProfileId when no explicit id is passed", () => {
    // The top-bar "15 min" button calls handleTemporaryEnable() with no arg;
    // that fallback path must keep working.
    const { result } = renderHook(() => useThrottleEditor(), { wrapper: createWrapper() });

    act(() => result.current.selectProfile(profilesState.current[0]!));
    act(() => result.current.handleTemporaryEnable());
    expect(setActiveMutateMock).toHaveBeenCalledWith("p1");
  });
});
