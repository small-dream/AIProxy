import { beforeEach, describe, expect, it } from "vitest";

import { useProxyStartStore } from "./proxy-start.store";

describe("proxy-start store", () => {
  beforeEach(() => {
    useProxyStartStore.getState().clearPortInUse();
    useProxyStartStore.getState().consumeOpenPortDialogRequest();
  });

  it("sets and clears the port-in-use failure", () => {
    useProxyStartStore.getState().setPortInUse({ port: 8888 });
    expect(useProxyStartStore.getState().portInUse).toEqual({ port: 8888 });

    useProxyStartStore.getState().clearPortInUse();
    expect(useProxyStartStore.getState().portInUse).toBeNull();
  });

  it("treats the port-dialog request as a one-shot flag", () => {
    expect(useProxyStartStore.getState().openPortDialogRequested).toBe(false);

    useProxyStartStore.getState().requestOpenPortDialog();
    expect(useProxyStartStore.getState().openPortDialogRequested).toBe(true);

    useProxyStartStore.getState().consumeOpenPortDialogRequest();
    expect(useProxyStartStore.getState().openPortDialogRequested).toBe(false);
  });

  it("setPortInUse(null) clears an existing failure", () => {
    useProxyStartStore.getState().setPortInUse({ port: 8888 });
    useProxyStartStore.getState().setPortInUse(null);
    expect(useProxyStartStore.getState().portInUse).toBeNull();
  });
});
