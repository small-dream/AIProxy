import { describe, it, expect, beforeEach } from "vitest";
import { useSessionContainerFilterStore } from "./session-container.store";

describe("SessionContainerFilterStore", () => {
  beforeEach(() => {
    useSessionContainerFilterStore.setState({ activeSessionIds: [] });
  });

  it("starts with empty session IDs", () => {
    const state = useSessionContainerFilterStore.getState();
    expect(state.activeSessionIds).toEqual([]);
  });

  it("sets active session IDs", () => {
    useSessionContainerFilterStore.getState().setActiveSessionIds(["s1", "s2"]);
    const state = useSessionContainerFilterStore.getState();
    expect(state.activeSessionIds).toEqual(["s1", "s2"]);
  });

  it("replaces active session IDs", () => {
    useSessionContainerFilterStore.getState().setActiveSessionIds(["s1"]);
    useSessionContainerFilterStore.getState().setActiveSessionIds(["s3", "s4"]);
    const state = useSessionContainerFilterStore.getState();
    expect(state.activeSessionIds).toEqual(["s3", "s4"]);
  });
});
