import { useMemo } from "react";

import {
  DEFAULT_PROXY_PORT,
  DEFAULT_WORKSPACE_ID,
  type StartProxyInput,
} from "@aiproxy/shared-types";

import { useProxyStatus } from "@/features/proxy-status/use-proxy-status";
import { useWorkspaces } from "@/features/workspace-manager/use-workspaces";

// Shared StartProxyInput assembly for the proxy lifecycle (status bar start
// button) and the setup wizard, so both start the proxy with identical
// parameters. Extracted from the initialStartProxyInput logic that previously
// lived inline inside useProxyLifecycle — keeping them in sync prevents the
// wizard and the top-bar button from diverging on port/ssl/workspace.
export function useProxyStartDefaults(): StartProxyInput {
  const { data: proxyStatus } = useProxyStatus();
  const { data: workspaces = [] } = useWorkspaces();

  return useMemo<StartProxyInput>(() => {
    const workspaceId = proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
    const currentWorkspace =
      workspaces.find((workspace) => workspace.id === workspaceId) ??
      workspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID) ??
      null;

    return {
      // Default to SSL on when the workspace isn't loaded yet — matches
      // createDefaultProxyStatus() and the settings draft default, so a
      // not-yet-loaded workspace doesn't start the proxy as HTTP-only.
      enableSsl: currentWorkspace?.sslEnabled ?? true,
      port: currentWorkspace?.proxyPort ?? DEFAULT_PROXY_PORT,
      workspaceId,
    };
  }, [proxyStatus?.activeWorkspaceId, workspaces]);
}
