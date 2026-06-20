import { create } from "zustand";

export type PortInUseFailure = { port: number };

/**
 * Cross-component signal for proxy start failures and the port-change dialog.
 *
 * The port dialog is owned by `useProxyLifecycle` (rendered in `AppShell`), but
 * out-of-tree callers like `SetupChecklistCard` (Sessions page, inside the
 * `<Outlet>`) need both to *read* the last port-in-use failure and to *request*
 * that dialog to open. This non-persistent store is the single bridge, modeled
 * after `notification.store.ts`. The dialog request is a one-shot flag: the
 * lifecycle consumes it immediately so it never re-opens on re-render.
 */
interface ProxyStartState {
  // Last start failure caused by the port already being taken; cleared on the
  // next successful start (see useStartProxy onSuccess).
  portInUse: PortInUseFailure | null;
  // One-shot request to open the port-change dialog. Consumed by useProxyLifecycle.
  openPortDialogRequested: boolean;
  setPortInUse: (failure: PortInUseFailure | null) => void;
  clearPortInUse: () => void;
  requestOpenPortDialog: () => void;
  consumeOpenPortDialogRequest: () => void;
}

export const useProxyStartStore = create<ProxyStartState>((set) => ({
  portInUse: null,
  openPortDialogRequested: false,
  setPortInUse: (portInUse) => set({ portInUse }),
  clearPortInUse: () => set({ portInUse: null }),
  requestOpenPortDialog: () => set({ openPortDialogRequested: true }),
  consumeOpenPortDialogRequest: () => set({ openPortDialogRequested: false }),
}));
