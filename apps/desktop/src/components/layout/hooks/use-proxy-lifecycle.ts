import { DEFAULT_PROXY_PORT, DEFAULT_WORKSPACE_ID, type PortOccupant } from "@aiproxy/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCertificateStatus } from "@/features/certificate-center/use-certificate-status";
import {
  useDisableSystemProxy,
  useEnableSystemProxy,
  useProxyStatus,
  useStartProxy,
  useStopProxy,
} from "@/features/proxy-status/use-proxy-status";
import { useUpdateWorkspace, useWorkspaces } from "@/features/workspace-manager/use-workspaces";
import { useI18n } from "@/i18n";

import { getErrorMessage, isTauriRuntime } from "./helpers";
import {
  isPortInUseError,
  readPortFromError,
  retryWhilePortInUse,
} from "@/features/proxy-status/proxy-start.helpers";
import { useProxyStartStore } from "@/features/proxy-status/proxy-start.store";
import { getPortOccupant, killProxyPortProcess } from "@/services/commands";

interface UseProxyLifecycleParams {
  onSnackbarMessage: (message: string | null) => void;
}

/**
 * Manages the full proxy lifecycle: auto-start on launch, manual start/stop,
 * port change dialog, and system proxy toggle.
 */
export function useProxyLifecycle({ onSnackbarMessage }: UseProxyLifecycleParams) {
  const { t } = useI18n();
  const { data: proxyStatus } = useProxyStatus();
  const { data: certificateStatus } = useCertificateStatus();
  const startProxyMutation = useStartProxy();
  const stopProxyMutation = useStopProxy();
  const enableSystemProxyMutation = useEnableSystemProxy();
  const disableSystemProxyMutation = useDisableSystemProxy();
  const updateWorkspaceMutation = useUpdateWorkspace();
  const { data: workspaces = [], isError: isWorkspacesError } = useWorkspaces();
  // Stable Zustand setter; declared before the auto-start effect that uses it.
  const setAutoStartInProgress = useProxyStartStore((s) => s.setAutoStartInProgress);

  const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const currentWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === workspaceId) ??
      workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID) ??
      null,
    [workspaceId, workspaces],
  );
  const configuredPort = currentWorkspace?.proxyPort ?? DEFAULT_PROXY_PORT;
  const configuredSslEnabled = currentWorkspace?.sslEnabled ?? false;
  const port = proxyStatus?.running ? proxyStatus.port : configuredPort;

  const [portDialogOpen, setPortDialogOpen] = useState(false);
  const [portDraft, setPortDraft] = useState(String(port));
  const [portDialogError, setPortDialogError] = useState<string | null>(null);
  const autoStartAttemptedRef = useRef(false);

  // Port-in-use recovery: the occupying process and the kill-and-restart flow.
  const [occupant, setOccupant] = useState<PortOccupant | null>(null);
  const [occupantLoading, setOccupantLoading] = useState(false);
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [isKilling, setIsKilling] = useState(false);
  const [occupantRefreshNonce, setOccupantRefreshNonce] = useState(0);

  const isProxyBusy = startProxyMutation.isPending || stopProxyMutation.isPending;
  const isSystemProxyBusy =
    enableSystemProxyMutation.isPending || disableSystemProxyMutation.isPending;
  const isBusy =
    isProxyBusy || isSystemProxyBusy || updateWorkspaceMutation.isPending || isWorkspacesError;
  const systemProxyActionDisabled =
    isSystemProxyBusy ||
    isProxyBusy ||
    (!proxyStatus?.systemProxyEnabled && !(proxyStatus?.running ?? false));

  const initialStartProxyInput = useMemo(
    () => ({
      enableSsl: configuredSslEnabled,
      port: configuredPort,
      workspaceId,
    }),
    [configuredPort, configuredSslEnabled, workspaceId],
  );

  // --- Auto-start proxy on launch ---
  useEffect(() => {
    if (!isTauriRuntime() || autoStartAttemptedRef.current) {
      return;
    }

    if (!proxyStatus || !certificateStatus || workspaces.length === 0) {
      return;
    }

    autoStartAttemptedRef.current = true;

    if (proxyStatus.running) {
      return;
    }

    // Only restore the system proxy when the workspace says the user explicitly
    // enabled it before (enable_system_proxy persists the flag). A fresh user
    // must reach the wizard's certificate-trust steps before any takeover, so
    // first run never hijacks system traffic with an untrusted root CA.
    const shouldRestoreSystemProxy = currentWorkspace?.systemProxyEnabled === true;

    // Signal that auto-start is in flight so first-run guidance (checklist /
    // wizard) stays hidden until startProxy (and the optional system-proxy
    // restore) finishes. captureReady is transiently false during this window.
    setAutoStartInProgress(true);

    let cancelled = false;

    void (async () => {
      try {
        const startedStatus = await startProxyMutation.mutateAsync(initialStartProxyInput);

        if (cancelled || startedStatus.systemProxyEnabled || !shouldRestoreSystemProxy) {
          return;
        }

        await enableSystemProxyMutation.mutateAsync(undefined);
      } catch (error) {
        // Don't silently swallow startup failures. A port conflict is the most
        // common cause and must surface immediately: open the port-change dialog
        // so the user knows the proxy never started. useStartProxy.onError also
        // records PORT_IN_USE in the shared store for SetupChecklistCard.
        if (isPortInUseError(error)) {
          const port = readPortFromError(error, initialStartProxyInput.port);
          setPortDraft(String(port));
          setPortDialogOpen(true);
          return;
        }

        onSnackbarMessage(getErrorMessage(error, t("common.errors.generic")));
      } finally {
        setAutoStartInProgress(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    certificateStatus,
    currentWorkspace,
    enableSystemProxyMutation,
    initialStartProxyInput,
    onSnackbarMessage,
    proxyStatus,
    setAutoStartInProgress,
    startProxyMutation,
    t,
    workspaceId,
    workspaces.length,
  ]);

  // Bridge out-of-tree port-dialog requests (e.g. SetupChecklistCard's "Change
  // port" button, which lives outside this hook's tree) into the dialog this
  // hook owns. One-shot signal: consume immediately so it never re-opens.
  const openPortDialogRequested = useProxyStartStore((s) => s.openPortDialogRequested);
  const consumeOpenPortDialogRequest = useProxyStartStore((s) => s.consumeOpenPortDialogRequest);
  useEffect(() => {
    if (!openPortDialogRequested) {
      return;
    }
    setPortDraft(String(port));
    setPortDialogError(null);
    setPortDialogOpen(true);
    consumeOpenPortDialogRequest();
  }, [openPortDialogRequested, port, consumeOpenPortDialogRequest]);

  // Current port-in-use failure (shared store). Drives the "end the occupying
  // process" option inside the port dialog.
  const portInUse = useProxyStartStore((s) => s.portInUse);

  // When the port dialog opens on a port-in-use failure, resolve the occupying
  // process so the user can choose to end it. `cancelled` discards stale
  // responses if the dialog closes or the failure changes mid-flight.
  useEffect(() => {
    if (!portDialogOpen || !portInUse) {
      setOccupant(null);
      return;
    }
    let cancelled = false;
    setOccupantLoading(true);
    void getPortOccupant(portInUse.port)
      .then((info) => {
        if (!cancelled) {
          setOccupant(info);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOccupant(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setOccupantLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [portDialogOpen, portInUse, occupantRefreshNonce]);

  // --- Port dialog helpers ---
  function openPortDialog() {
    setPortDraft(String(port));
    setPortDialogError(null);
    setPortDialogOpen(true);
  }

  function getProxyStartErrorMessage(error: unknown, requestedPort: number) {
    if (isPortInUseError(error)) {
      return t("appShell.proxyPortInUse", {
        port: readPortFromError(error, requestedPort),
      });
    }

    return getErrorMessage(error, t("common.errors.generic"));
  }

  // --- Proxy control handlers ---
  async function handleStartProxy(input = initialStartProxyInput) {
    if (isWorkspacesError) return;
    try {
      await startProxyMutation.mutateAsync(input);
    } catch (error) {
      const requestedPort = input.port ?? port;

      if (isPortInUseError(error)) {
        setPortDraft(String(requestedPort));
        setPortDialogOpen(true);
        return;
      }

      onSnackbarMessage(getProxyStartErrorMessage(error, requestedPort));
    }
  }

  async function handleStopProxy() {
    try {
      await stopProxyMutation.mutateAsync(workspaceId);
    } catch (error) {
      onSnackbarMessage(getErrorMessage(error, t("common.errors.generic")));
    }
  }

  async function handlePortApply() {
    if (isWorkspacesError) return;
    const nextPort = Number.parseInt(portDraft.trim(), 10);

    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      setPortDialogError(t("appShell.proxyPortValidation"));
      return;
    }

    try {
      if (nextPort !== configuredPort) {
        await updateWorkspaceMutation.mutateAsync({
          proxyPort: nextPort,
          workspaceId,
        });
      }

      await startProxyMutation.mutateAsync({
        enableSsl: proxyStatus?.running ? proxyStatus.sslEnabled : configuredSslEnabled,
        port: nextPort,
        workspaceId,
      });

      setPortDialogOpen(false);
    } catch (error) {
      setPortDialogError(getProxyStartErrorMessage(error, nextPort));
    }
  }

  // Kill the occupying process (after server-side PID re-verification) and
  // restart the proxy on the same port. System-proxy rebind follows start_proxy's
  // existing semantics — the frontend does not call enable/disable here.
  async function handleKillAndRestart() {
    if (!occupant || !portInUse) {
      return;
    }
    setIsKilling(true);
    try {
      await killProxyPortProcess({
        port: portInUse.port,
        pid: occupant.pid,
        name: occupant.name,
      });
      // SIGKILL is asynchronous: the kill command returning success only means
      // the signal was delivered, not that the port is reaped. Retry the bind
      // with a short backoff so we don't lose the race against the kernel.
      await retryWhilePortInUse(() =>
        startProxyMutation.mutateAsync({ ...initialStartProxyInput, port: portInUse.port }),
      );
      setKillConfirmOpen(false);
      setPortDialogOpen(false);
      useProxyStartStore.getState().clearPortInUse();
    } catch (error) {
      // The kill already ran; if the restart still fails, drop back to the port
      // dialog (refreshed) so the user can change port instead of being stuck.
      setKillConfirmOpen(false);
      onSnackbarMessage(getErrorMessage(error, t("common.errors.generic")));
      // The occupant may have changed (PROCESS_CHANGED) — re-query before retry.
      setOccupantRefreshNonce((nonce) => nonce + 1);
    } finally {
      setIsKilling(false);
    }
  }

  async function handleSystemProxyToggle() {
    if (systemProxyActionDisabled) {
      return;
    }

    try {
      if (proxyStatus?.systemProxyEnabled) {
        await disableSystemProxyMutation.mutateAsync(undefined);
        return;
      }

      await enableSystemProxyMutation.mutateAsync(undefined);
    } catch (error) {
      onSnackbarMessage(getErrorMessage(error, t("common.errors.generic")));
    }
  }

  return {
    // Proxy status data
    proxyStatus,
    certificateStatus,
    port,
    configuredPort,
    configuredSslEnabled,
    workspaceId,

    // Busy states
    isProxyBusy,
    isBusy,
    systemProxyActionDisabled,
    isWorkspacesError,

    // Port dialog state
    portDialogOpen,
    portDraft,
    portDialogError,
    setPortDialogOpen,
    setPortDraft,
    setPortDialogError,
    openPortDialog,

    // Port-in-use recovery (end the occupying process, restart on same port)
    portInUse,
    occupant,
    occupantLoading,
    killConfirmOpen,
    setKillConfirmOpen,
    handleKillAndRestart,
    isKilling,

    // Proxy control handlers
    handleStartProxy,
    handleStopProxy,
    handlePortApply,
    handleSystemProxyToggle,
    initialStartProxyInput,
  };
}
