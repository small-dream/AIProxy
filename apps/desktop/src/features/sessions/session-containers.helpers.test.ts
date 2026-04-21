import type { SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import {
  clearActiveSessionContainer,
  clearOtherSessionsInActiveContainer,
  closeSessionContainer,
  createAdditionalSessionContainer,
  createInitialSessionContainerState,
  removeSessionContainerSummary,
  seedSessionContainers,
  setActiveSessionContainer,
  upsertSessionContainerSummary,
} from "./session-containers.helpers";

function createSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    durationMs: 42,
    finishedAt: "2026-04-11T10:00:03.000Z",
    host: "example.com",
    id: "session-1",
    method: "GET",
    path: "/",
    protocol: "HTTP/1.1",
    sizeBytes: 512,
    startedAt: "2026-04-11T10:00:00.000Z",
    statusCode: 200,
    url: "http://example.com/",
    ...overrides,
  };
}

describe("session-containers.helpers", () => {
  it("stores the initial inspector split ratio when provided", () => {
    const state = createInitialSessionContainerState({ inspectorSplitRatio: 0.61 });

    expect(state.containers[0]?.inspectorSplitRatio).toBe(0.61);
  });

  it("inherits the active container inspector split ratio for new tabs", () => {
    let state = createInitialSessionContainerState({ inspectorSplitRatio: 0.64 });
    state = createAdditionalSessionContainer(state);

    expect(state.containers[1]?.inspectorSplitRatio).toBe(0.64);
  });

  it("seeds the default container with the initial runtime sessions", () => {
    const state = createInitialSessionContainerState();
    const seededState = seedSessionContainers(state, [
      createSessionSummary({ id: "session-a", url: "http://example.com/a" }),
      createSessionSummary({ id: "session-b", url: "http://example.com/b" }),
    ]);

    expect(seededState.hydrated).toBe(true);
    expect(seededState.containers[0]?.sessionIds).toEqual(["session-a", "session-b"]);
    expect(seededState.sessionOwnerById).toMatchObject({
      "session-a": seededState.activeContainerId,
      "session-b": seededState.activeContainerId,
    });
  });

  it("routes brand-new sessions into the active container and keeps later updates in the original owner", () => {
    const firstSession = createSessionSummary({
      host: "api.example.com",
      id: "session-a",
      url: "http://api.example.com/a",
    });

    let state = createInitialSessionContainerState();
    state = seedSessionContainers(state, [firstSession]);
    state = createAdditionalSessionContainer(state);

    const secondContainerId = state.activeContainerId;

    state = upsertSessionContainerSummary(
      state,
      createSessionSummary({
        host: "api.example.com",
        id: "session-b",
        path: "/pending",
        statusCode: 0,
        url: "http://api.example.com/pending",
      }),
    );

    state = setActiveSessionContainer(state, "session-container-1");

    state = upsertSessionContainerSummary(
      state,
      createSessionSummary({
        host: "api.example.com",
        id: "session-b",
        path: "/pending",
        statusCode: 204,
        url: "http://api.example.com/pending",
      }),
    );

    expect(state.containers[0]?.sessionIds).toEqual(["session-a"]);
    expect(state.containers[1]?.sessionIds).toEqual(["session-b"]);
    expect(state.sessionOwnerById["session-b"]).toBe(secondContainerId);
    expect(state.sessionSummaryById["session-b"]?.statusCode).toBe(204);
  });

  it("clears only the active container and preserves the others", () => {
    let state = createInitialSessionContainerState({ inspectorSplitRatio: 0.58 });
    state = seedSessionContainers(state, [
      createSessionSummary({ id: "session-a", url: "http://example.com/a" }),
    ]);
    state = createAdditionalSessionContainer(state);
    state = upsertSessionContainerSummary(
      state,
      createSessionSummary({ id: "session-b", url: "http://example.com/b" }),
    );

    state = clearActiveSessionContainer(state);

    expect(state.containers[0]?.sessionIds).toEqual(["session-a"]);
    expect(state.containers[1]?.sessionIds).toEqual([]);
    expect(state.containers[1]?.inspectorSplitRatio).toBe(0.58);
    expect(state.sessionSummaryById["session-a"]).toBeDefined();
    expect(state.sessionSummaryById["session-b"]).toBeUndefined();
  });

  it("keeps a single selected session when clearing others in the active container", () => {
    let state = createInitialSessionContainerState();
    state = seedSessionContainers(state, [
      createSessionSummary({ id: "session-a", url: "http://example.com/a" }),
      createSessionSummary({ id: "session-b", url: "http://example.com/b" }),
    ]);
    state = clearOtherSessionsInActiveContainer(state, "session-b");

    expect(state.containers[0]?.sessionIds).toEqual(["session-b"]);
    expect(state.containers[0]?.selectedSessionId).toBe("session-b");
    expect(state.sessionSummaryById["session-a"]).toBeUndefined();
  });

  it("removes a session and falls back to the nearest remaining selection", () => {
    let state = createInitialSessionContainerState();
    state = seedSessionContainers(state, [
      createSessionSummary({ id: "session-a", url: "http://example.com/a" }),
      createSessionSummary({ id: "session-b", url: "http://example.com/b" }),
      createSessionSummary({ id: "session-c", url: "http://example.com/c" }),
    ]);
    state = {
      ...state,
      containers: state.containers.map((container) => ({
        ...container,
        selectedSessionId: "session-b",
      })),
    };

    state = removeSessionContainerSummary(state, "session-b");

    expect(state.containers[0]?.sessionIds).toEqual(["session-a", "session-c"]);
    expect(state.containers[0]?.selectedSessionId).toBe("session-c");
  });

  it("drops the closed container without affecting the remaining active capture stream", () => {
    let state = createInitialSessionContainerState();
    state = seedSessionContainers(state, [
      createSessionSummary({ id: "session-a", url: "http://example.com/a" }),
    ]);
    state = createAdditionalSessionContainer(state);
    state = upsertSessionContainerSummary(
      state,
      createSessionSummary({ id: "session-b", url: "http://example.com/b" }),
    );

    state = closeSessionContainer(state, "session-container-2");

    expect(state.containers).toHaveLength(1);
    expect(state.activeContainerId).toBe("session-container-1");
    expect(state.sessionSummaryById["session-a"]).toBeDefined();
    expect(state.sessionSummaryById["session-b"]).toBeUndefined();
  });
});
