import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  parseWorkspace,
  parseWorkspaces,
  type Workspace,
} from "@aiproxy/shared-types";

import { logDevDebug, logDevInfo } from "@/services/logger/dev-logger";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

const MOCK_WORKSPACE: Omit<Workspace, "id" | "name" | "createdAt" | "updatedAt"> = {
  proxyPort: 8888,
  sslEnabled: true,
  http2Enabled: true,
  systemProxyEnabled: false,
  verifyUpstreamTls: false,
  tlsVerifyHosts: [],
  storagePath: "",
};

function mockWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = new Date().toISOString();
  return {
    id: "default",
    name: "Default",
    ...MOCK_WORKSPACE,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export async function listWorkspaces(): Promise<Workspace[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_workspaces_bypassed_non_tauri_runtime");
    return [mockWorkspace()];
  }

  try {
    logDevInfo("ui.commands", "list_workspaces_requested");
    const payload = await invoke<unknown>("list_workspaces");
    const workspaces = parseWorkspaces(payload);

    logDevDebug("ui.commands", "list_workspaces_succeeded", {
      count: workspaces.length,
    });

    return workspaces;
  } catch (error) {
    reportCommandFailure("list_workspaces", error);
    throw coerceAppError(error);
  }
}

export async function createWorkspace(input: {
  name: string;
  proxyPort: number;
  sslEnabled?: boolean;
  http2Enabled?: boolean;
}): Promise<Workspace> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "create_workspace_bypassed_non_tauri_runtime", input);
    return mockWorkspace({
      id: crypto.randomUUID(),
      name: input.name,
      proxyPort: input.proxyPort,
      sslEnabled: input.sslEnabled ?? true,
      http2Enabled: input.http2Enabled ?? true,
    });
  }

  try {
    logDevInfo("ui.commands", "create_workspace_requested", input);
    const payload = await invoke<unknown>("create_workspace", { input });
    const workspace = parseWorkspace(payload);

    logDevInfo("ui.commands", "create_workspace_succeeded", {
      workspaceId: workspace.id,
    });

    return workspace;
  } catch (error) {
    reportCommandFailure("create_workspace", error);
    throw coerceAppError(error);
  }
}

export async function loadWorkspace(workspaceId: string): Promise<Workspace> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "load_workspace_bypassed_non_tauri_runtime", { workspaceId });
    return mockWorkspace({
      id: workspaceId,
      name: workspaceId === "default" ? "Default" : workspaceId,
    });
  }

  try {
    logDevInfo("ui.commands", "load_workspace_requested", { workspaceId });
    const payload = await invoke<unknown>("load_workspace", {
      input: { workspaceId },
    });
    const workspace = parseWorkspace(payload);

    logDevInfo("ui.commands", "load_workspace_succeeded", {
      workspaceId: workspace.id,
      name: workspace.name,
    });

    return workspace;
  } catch (error) {
    reportCommandFailure("load_workspace", error, workspaceId);
    throw coerceAppError(error);
  }
}

export async function updateWorkspace(input: {
  workspaceId: string;
  name?: string;
  proxyPort?: number;
  sslEnabled?: boolean;
  http2Enabled?: boolean;
  /** H3: enable/disable upstream TLS verification. Omit to leave unchanged. */
  verifyUpstreamTls?: boolean;
  /**
   * H3: hostnames always TLS-verified even when verifyUpstreamTls is false.
   * Array form (matches the Workspace.tlsVerifyHosts contract); the backend
   * serializes it to the JSON-encoded DB column. Omit to leave unchanged.
   */
  tlsVerifyHosts?: string[];
}): Promise<Workspace> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "update_workspace_bypassed_non_tauri_runtime", input);
    return mockWorkspace({
      id: input.workspaceId,
      name: input.name ?? "Default",
      proxyPort: input.proxyPort ?? 8888,
      sslEnabled: input.sslEnabled ?? true,
      http2Enabled: input.http2Enabled ?? true,
      verifyUpstreamTls: input.verifyUpstreamTls ?? false,
      // H3: reflect the saved allowlist in the browser/dev fallback so the
      // mock stays consistent with the persisted workspace shape.
      tlsVerifyHosts: input.tlsVerifyHosts ?? [],
    });
  }

  try {
    logDevInfo("ui.commands", "update_workspace_requested", input);
    const payload = await invoke<unknown>("update_workspace", { input });
    const workspace = parseWorkspace(payload);

    logDevInfo("ui.commands", "update_workspace_succeeded", {
      workspaceId: workspace.id,
    });

    return workspace;
  } catch (error) {
    reportCommandFailure("update_workspace", error, input.workspaceId);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// API Collection commands
// ---------------------------------------------------------------------------
