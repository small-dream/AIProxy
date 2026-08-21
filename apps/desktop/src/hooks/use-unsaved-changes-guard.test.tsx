import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { useUnsavedChangesGuard } from "./use-unsaved-changes-guard";

type GuardApi = ReturnType<typeof useUnsavedChangesGuard>;

// The guard needs a data router (useBlocker), so mount it inside a memory
// router with a second route to navigate to.
function mountGuard(isDirty: boolean) {
  let api!: GuardApi;
  function Inner() {
    api = useUnsavedChangesGuard(isDirty);
    return <div>rules</div>;
  }
  const router = createMemoryRouter(
    [
      { path: "/rules", element: <Inner /> },
      { path: "/other", element: <div>other</div> },
    ],
    { initialEntries: ["/rules"] },
  );
  render(<RouterProvider router={router} />);
  return {
    router,
    get api() {
      return api;
    },
  };
}

describe("useUnsavedChangesGuard (P0-2)", () => {
  it("allows leaving immediately when not dirty", async () => {
    const harness = mountGuard(false);
    await expect(harness.api.confirmLeave()).resolves.toBe(true);
    expect(harness.api.dialogOpen).toBe(false);
  });

  it("does not intercept route navigation when not dirty", async () => {
    const harness = mountGuard(false);
    act(() => void harness.router.navigate("/other"));
    await waitFor(() => expect(harness.router.state.location.pathname).toBe("/other"));
    expect(harness.api.dialogOpen).toBe(false);
  });

  it("confirmLeave resolves false on cancel and keeps the draft decision closed after", async () => {
    const harness = mountGuard(true);
    let allowed: boolean | undefined;
    act(() => {
      void harness.api.confirmLeave().then((value) => {
        allowed = value;
      });
    });
    expect(harness.api.dialogOpen).toBe(true);

    act(() => harness.api.handleCancel());
    await waitFor(() => expect(allowed).toBe(false));
    expect(harness.api.dialogOpen).toBe(false);
  });

  it("intercepts route navigation while dirty; confirm proceeds", async () => {
    const harness = mountGuard(true);

    act(() => void harness.router.navigate("/other"));
    // Blocked: still on /rules with the confirmation open.
    expect(harness.router.state.location.pathname).toBe("/rules");
    expect(harness.api.dialogOpen).toBe(true);

    act(() => harness.api.handleConfirm());
    await waitFor(() => expect(harness.router.state.location.pathname).toBe("/other"));
  });

  it("intercepts route navigation while dirty; cancel stays put", async () => {
    const harness = mountGuard(true);

    act(() => void harness.router.navigate("/other"));
    expect(harness.router.state.location.pathname).toBe("/rules");

    act(() => harness.api.handleCancel());
    expect(harness.router.state.location.pathname).toBe("/rules");
    expect(harness.api.dialogOpen).toBe(false);

    // After a reset the blocker must re-arm for the next navigation.
    act(() => void harness.router.navigate("/other"));
    expect(harness.router.state.location.pathname).toBe("/rules");
    expect(harness.api.dialogOpen).toBe(true);
  });
});
