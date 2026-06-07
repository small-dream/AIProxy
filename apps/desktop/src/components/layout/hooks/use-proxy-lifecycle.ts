import { DEFAULT_PROXY_PORT, DEFAULT_WORKSPACE_ID } from "@aiproxy/shared-types";
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

import { getErrorMessage, isPortInUseError } from "./helpers";

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
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    if (!isTauri || autoStartAttemptedRef.current) {
      return;
    }

    if (!proxyStatus || !certificateStatus || workspaces.length === 0) {
      return;
    }

    autoStartAttemptedRef.current = true;

    if (proxyStatus.running) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const startedStatus = await startProxyMutation.mutateAsync(initialStartProxyInput);

        if (cancelled || startedStatus.systemProxyEnabled) {
          return;
        }

        await enableSystemProxyMutation.mutateAsync(undefined);
      } catch {
        // Startup auto-boot is best-effort. Manual controls remain available.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    certificateStatus,
    enableSystemProxyMutation,
    initialStartProxyInput,
    proxyStatus,
    startProxyMutation,
    workspaceId,
    workspaces.length,
  ]);

  // --- Port dialog helpers ---
  function openPortDialog() {
    setPortDraft(String(port));
    setPortDialogError(null);
    setPortDialogOpen(true);
  }

  function getProxyStartErrorMessage(error: unknown, requestedPort: number) {
    const normalizedError = error as Parameters<typeof isPortInUseError>[0];
    const errorPort = (() => {
      const appError = error as { details?: { port?: number } };
      return typeof appError?.details?.port === "number" ? appError.details.port : requestedPort;
    })();

    if (isPortInUseError(normalizedError)) {
      return t("appShell.proxyPortInUse", {
        port: errorPort,
      });
    }

    return getErrorMessage(normalizedError, t("common.errors.generic"));
  }

  // --- Proxy control handlers ---
  async function handleStartProxy(input = initialStartProxyInput) {
    if (isWorkspacesError) return;
    try {
      await startProxyMutation.mutateAsync(input);
    } catch (error) {
      const requestedPort = input.port ?? port;
      const message = getProxyStartErrorMessage(error, requestedPort);

      if (isPortInUseError(error)) {
        setPortDraft(String(requestedPort));
        setPortDialogError(message);
        setPortDialogOpen(true);
        return;
      }

      onSnackbarMessage(message);
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

    // Proxy control handlers
    handleStartProxy,
    handleStopProxy,
    handlePortApply,
    handleSystemProxyToggle,
    initialStartProxyInput,
  };
}
