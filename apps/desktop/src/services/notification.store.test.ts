import { beforeEach, describe, expect, it } from "vitest";

import { useNotificationStore } from "./notification.store";

describe("useNotificationStore", () => {
  beforeEach(() => {
    useNotificationStore.setState({ queue: [] });
  });

  it("appends distinct messages to the queue", () => {
    const { push } = useNotificationStore.getState();
    push("first error");
    push("second error");

    const queue = useNotificationStore.getState().queue;
    expect(queue).toHaveLength(2);
    expect(queue.map((n) => n.message)).toEqual(["first error", "second error"]);
  });

  // M19: a polling query that fails repeatedly must NOT stack N identical
  // toasts — consecutive duplicate messages are collapsed so the Snackbar
  // does not replay the same error for minutes after the blip resolves.
  it("collapses consecutive duplicate messages", () => {
    const { push } = useNotificationStore.getState();
    push("network error");
    push("network error");
    push("network error");

    const queue = useNotificationStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue.map((n) => n.message)).toEqual(["network error"]);
  });

  // M19: only CONSECUTIVE duplicates collapse — an interleaved distinct
  // message must still surface.
  it("keeps non-consecutive duplicates", () => {
    const { push } = useNotificationStore.getState();
    push("error A");
    push("error B");
    push("error A"); // not consecutive with the previous "error A"

    const queue = useNotificationStore.getState().queue;
    expect(queue.map((n) => n.message)).toEqual(["error A", "error B", "error A"]);
  });

  // M19: a query error storm must not grow the queue unbounded. The Snackbar
  // drains one entry every 4s, so without a cap 50 failures became a 200s
  // tail of stale toasts. The queue drops the OLDEST entries beyond the cap.
  it("caps the queue at MAX_QUEUE_SIZE, dropping the oldest", () => {
    const { push } = useNotificationStore.getState();
    // Push 10 distinct messages — the cap is 5.
    for (let i = 0; i < 10; i++) {
      push(`error ${i}`);
    }

    const queue = useNotificationStore.getState().queue;
    expect(queue).toHaveLength(5);
    // The most recent 5 survive; the oldest 5 are dropped.
    expect(queue.map((n) => n.message)).toEqual([
      "error 5",
      "error 6",
      "error 7",
      "error 8",
      "error 9",
    ]);
  });

  it("shift removes and returns the oldest notification", () => {
    const { push, shift } = useNotificationStore.getState();
    push("first");
    push("second");

    const oldest = shift();
    expect(oldest?.message).toBe("first");
    expect(useNotificationStore.getState().queue).toHaveLength(1);
    expect(useNotificationStore.getState().queue.map((n) => n.message)).toEqual(["second"]);
  });
});
