import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThrottleProfile, ThrottleRule } from "@aiproxy/shared-types";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  THROTTLE_PROFILES_QUERY_KEY,
  THROTTLE_RULES_QUERY_KEY,
  useSaveThrottleProfile,
  useSaveThrottleRule,
} from "./use-throttle-profiles";

const saveThrottleProfileMock = vi.fn();
const saveThrottleRuleMock = vi.fn();

vi.mock("@/services/commands", () => ({
  saveThrottleProfile: (input: unknown) => saveThrottleProfileMock(input),
  saveThrottleRule: (input: unknown) => saveThrottleRuleMock(input),
  // Present in the module's import list but unused by the hooks under test.
  listThrottleProfiles: vi.fn(),
  listThrottleRules: vi.fn(),
  deleteThrottleRule: vi.fn(),
  setActiveThrottleProfile: vi.fn(),
  getThrottleRuntimeStats: vi.fn(),
}));

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const p1: ThrottleProfile = {
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
};

const r1: ThrottleRule = {
  id: "r1",
  name: "R1",
  workspaceId: "default",
  profileId: "p1",
  urlPattern: "*",
  enabled: true,
  priority: 100,
  methods: [],
  stage: "both",
  note: "",
};

beforeEach(() => {
  saveThrottleProfileMock.mockReset();
  saveThrottleRuleMock.mockReset();
});

describe("useSaveThrottleProfile (N-1)", () => {
  it("writes the saved profile into the cache immediately, before the refetch lands", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData<ThrottleProfile[]>(THROTTLE_PROFILES_QUERY_KEY, [p1]);

    const saved: ThrottleProfile = { ...p1, id: "new-id", name: "Brand New" };
    saveThrottleProfileMock.mockResolvedValue(saved);

    const { result } = renderHook(() => useSaveThrottleProfile(), {
      wrapper: createWrapper(client),
    });
    // Omit<ThrottleProfile, "id"> input — the exactOptionalPropertyTypes
    // build forbids `id: undefined`, so construct the fields explicitly.
    await act(async () => {
      await result.current.mutateAsync({
        name: "Brand New",
        workspaceId: "default",
        latencyMs: 0,
        uploadKbps: 1,
        downloadKbps: 1,
        packetLossRatio: 0,
        enabled: false,
        preset: false,
        note: "",
      });
    });

    // The editor's auto-select effect guards on profiles.some(id ===
    // selected). Before N-1 the cache was only invalidated, so the freshly
    // saved id was missing for a full render pass and the selection snapped
    // back to an existing profile.
    const cached = client.getQueryData<ThrottleProfile[]>(THROTTLE_PROFILES_QUERY_KEY);
    expect(cached?.some((profile) => profile.id === "new-id")).toBe(true);
    // The existing entry is preserved.
    expect(cached?.some((profile) => profile.id === "p1")).toBe(true);
  });
});

describe("useSaveThrottleRule (N-1)", () => {
  it("writes the saved rule into the cache immediately, before the refetch lands", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData<ThrottleRule[]>(THROTTLE_RULES_QUERY_KEY, [r1]);

    const saved: ThrottleRule = { ...r1, id: "new-rule", name: "Edited" };
    saveThrottleRuleMock.mockResolvedValue(saved);

    const { result } = renderHook(() => useSaveThrottleRule(), {
      wrapper: createWrapper(client),
    });
    // Omit<ThrottleRule, "id"> input — explicit fields, no `id: undefined`
    // (forbidden by exactOptionalPropertyTypes).
    await act(async () => {
      await result.current.mutateAsync({
        name: "Edited",
        workspaceId: "default",
        profileId: "p1",
        urlPattern: "*",
        enabled: true,
        priority: 100,
        methods: [],
        stage: "both",
        note: "",
      });
    });

    const cached = client.getQueryData<ThrottleRule[]>(THROTTLE_RULES_QUERY_KEY);
    expect(cached?.some((rule) => rule.id === "new-rule")).toBe(true);
    expect(cached?.some((rule) => rule.id === "r1")).toBe(true);
  });
});
