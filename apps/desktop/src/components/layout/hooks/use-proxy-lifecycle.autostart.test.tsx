import {
  createDefaultProxyStatus,
  type CertificateStatus,
  type ProxyStatus,
  type Workspace,
} from "@aiproxy/shared-types";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useProxyLifecycle } from "./use-proxy-lifecycle";

// --- Controllable fixture state (re-pointed per test) ---
const proxyStatusState: { current: ProxyStatus | undefined } = { current: undefined };
const certStatusState: { current: CertificateStatus | undefined } = { current: undefined };
const workspacesState: { current: Workspace[] } = { current: [] };
const startResultState: { current: ProxyStatus } = { current: createDefaultProxyStatus() };

const startMutateAsync = vi.fn(async () => startResultState.current);
const enableSystemProxyMutateAsync = vi.fn(async () => createDefaultProxyStatus());

function createWorkspace(overrides: Partial<Workspace>): Workspace {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "default",
    name: "Default",
    proxyPort: 8888,
    sslEnabled: true,
    systemProxyEnabled: false,
    storagePath: "/tmp/aiproxy-test",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

vi.mock("@/features/certificate-center/use-certificate-status", () => ({
  useCertificateStatus: () => ({ data: certStatusState.current }),
}));

vi.mock("@/features/proxy-status/use-proxy-status", () => ({
  useProxyStatus: () => ({ data: proxyStatusState.current }),
  useStartProxy: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useStopProxy: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEnableSystemProxy: () => ({ mutateAsync: enableSystemProxyMutateAsync, isPending: false }),
  useDisableSystemProxy: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/features/workspace-manager/use-workspaces", () => ({
  useWorkspaces: () => ({ data: workspacesState.current, isError: false }),
  useUpdateWorkspace: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/services/commands", () => ({
  getPortOccupant: vi.fn(),
  killProxyPortProcess: vi.fn(),
}));

// Auto-start only runs inside the Tauri runtime.
vi.mock("./helpers", () => ({
  isTauriRuntime: () => true,
  getErrorMessage: (error: unknown) => String(error),
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, tList: (key: string) => [key], locale: "en-US" }),
}));

function primeLoadedState() {
  proxyStatusState.current = createDefaultProxyStatus();
  certStatusState.current = {
    certPath: "/tmp/root-ca.pem",
    trusted: false,
    platform: "macos",
  };
  startResultState.current = createDefaultProxyStatus();
}

beforeEach(() => {
  startMutateAsync.mockClear();
  enableSystemProxyMutateAsync.mockClear();
  primeLoadedState();
});

describe("useProxyLifecycle auto-start", () => {
  it("starts the proxy but does not take over the system proxy on first run", async () => {
    workspacesState.current = [createWorkspace({ systemProxyEnabled: false })];

    renderHook(() => useProxyLifecycle({ onSnackbarMessage: vi.fn() }));

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalledTimes(1));
    expect(startMutateAsync).toHaveBeenCalledWith({
      enableSsl: true,
      port: 8888,
      workspaceId: "default",
    });
    // Let any (unexpected) trailing enable call flush before asserting absence.
    await waitFor(() => expect(enableSystemProxyMutateAsync).not.toHaveBeenCalled());
  });

  it("restores the system proxy when the workspace persisted it as enabled", async () => {
    workspacesState.current = [createWorkspace({ systemProxyEnabled: true })];

    renderHook(() => useProxyLifecycle({ onSnackbarMessage: vi.fn() }));

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(enableSystemProxyMutateAsync).toHaveBeenCalledTimes(1));
  });

  it("skips the extra enable when startProxy already reports the system proxy on", async () => {
    workspacesState.current = [createWorkspace({ systemProxyEnabled: true })];
    startResultState.current = { ...createDefaultProxyStatus(), systemProxyEnabled: true };

    renderHook(() => useProxyLifecycle({ onSnackbarMessage: vi.fn() }));

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(enableSystemProxyMutateAsync).not.toHaveBeenCalled());
  });

  it("does not auto-start when the proxy is already running", async () => {
    workspacesState.current = [createWorkspace({ systemProxyEnabled: true })];
    proxyStatusState.current = { ...createDefaultProxyStatus(), running: true };

    renderHook(() => useProxyLifecycle({ onSnackbarMessage: vi.fn() }));

    await waitFor(() => expect(proxyStatusState.current?.running).toBe(true));
    expect(startMutateAsync).not.toHaveBeenCalled();
    expect(enableSystemProxyMutateAsync).not.toHaveBeenCalled();
  });

  it("does not auto-start before workspaces are loaded", async () => {
    workspacesState.current = [];

    renderHook(() => useProxyLifecycle({ onSnackbarMessage: vi.fn() }));

    await waitFor(() => expect(certStatusState.current?.trusted).toBe(false));
    expect(startMutateAsync).not.toHaveBeenCalled();
    expect(enableSystemProxyMutateAsync).not.toHaveBeenCalled();
  });
});
