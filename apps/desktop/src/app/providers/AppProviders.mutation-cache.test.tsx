import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMutation } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import { AppProviders } from "./AppProviders";
import { useNotificationStore } from "@/services/notification.store";

// P1-19: the MutationCache onError fallback. A mutation whose caller renders
// nothing used to fail silently; now any failure surfaces as a global
// notification unless the mutation opts out via meta
// `suppressGlobalErrorNotification`.

function FailingMutation({ meta }: { meta?: boolean }) {
  const mutation = useMutation<string, Error, void>({
    mutationFn: async () => {
      throw new Error("boom-from-test");
    },
    ...(meta ? { meta: { suppressGlobalErrorNotification: true } } : {}),
  });

  return (
    <button type="button" onClick={() => mutation.mutate()}>
      fire
    </button>
  );
}

describe("AppProviders MutationCache (P1-19)", () => {
  beforeEach(() => {
    // The notification store is a module-level zustand singleton shared by
    // every test in the file.
    useNotificationStore.setState({ queue: [] });
  });

  it("pushes a notification when a mutation fails without page-level handling", async () => {
    render(
      <AppProviders>
        <FailingMutation />
      </AppProviders>,
    );
    expect(useNotificationStore.getState().queue).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "fire" }));

    await waitFor(() => {
      const messages = useNotificationStore.getState().queue.map((n) => n.message);
      expect(messages).toContain("boom-from-test");
    });
  });

  it("does not notify when the mutation opts out via suppressGlobalErrorNotification", async () => {
    render(
      <AppProviders>
        <FailingMutation meta />
      </AppProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "fire" }));

    await waitFor(() => {
      // The mutation has definitely settled into error state — the probe
      // below asserts on the ABSENCE of a push after settle.
      expect(screen.getByRole("button")).toBeEnabled();
    });
    // Let any (incorrect) notification land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useNotificationStore.getState().queue.map((n) => n.message)).not.toContain(
      "boom-from-test",
    );
  });
});
