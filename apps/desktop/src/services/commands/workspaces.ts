import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  parseSslProxyingExclusions,
  parseUpstreamProxyProbeResult,
  parseWorkspace,
  parseWorkspaces,
  type SslProxyingSettings,
  type UpstreamProxyProbeResult,
  type UpstreamProxySettings,
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
  sslBlindHosts: [],
  storagePath: "",
};

/**
 * Strip the upstream proxy password before anything reaches the dev log.
 * The log is written to disk and routinely pasted into bug reports, so the
 * credential must never appear in it.
 */
function redactUpstreamProxy<T extends { upstreamProxy?: UpstreamProxySettings }>(
  input: T,
): T & { upstreamProxy?: UpstreamProxySettings } {
  if (!input.upstreamProxy) return input;
  return {
    ...input,
    upstreamProxy: {
      ...input.upstreamProxy,
      password: input.upstreamProxy.password ? "***" : input.upstreamProxy.password,
    },
  };
}

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
  /**
   * Hostnames for which SSL decryption is disabled while the workspace-level
   * switch stays on (privacy / certificate-pinning escape hatch). Array form;
   * omit to leave unchanged.
   */
  sslBlindHosts?: string[];
  /**
   * Upstream (chained) proxy settings. Omit to leave unchanged; send a value
   * with `enabled: false` to keep the configuration but route directly.
   * Takes effect on the next proxy start/restart.
   */
  upstreamProxy?: UpstreamProxySettings;
  /**
   * Per-host SSL proxying policy. Omit to leave unchanged. Takes effect on
   * the next proxy start/restart.
   */
  sslProxying?: SslProxyingSettings;
}): Promise<Workspace> {
  if (!isTauriRuntime()) {
    logDevDebug(
      "ui.commands",
      "update_workspace_bypassed_non_tauri_runtime",
      redactUpstreamProxy(input),
    );
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
      sslBlindHosts: input.sslBlindHosts ?? [],
      ...(input.upstreamProxy ? { upstreamProxy: input.upstreamProxy } : {}),
      ...(input.sslProxying ? { sslProxying: input.sslProxying } : {}),
    });
  }

  try {
    logDevInfo("ui.commands", "update_workspace_requested", redactUpstreamProxy(input));
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

/**
 * Verify an upstream proxy configuration by opening a real tunnel through it.
 *
 * Tests the supplied settings regardless of their `enabled` flag, so a user can
 * validate a configuration before switching it on.
 */
export async function testUpstreamProxy(input: {
  settings: UpstreamProxySettings;
  probeHost?: string;
  probePort?: number;
}): Promise<UpstreamProxyProbeResult> {
  if (!isTauriRuntime()) {
    logDevDebug(
      "ui.commands",
      "test_upstream_proxy_bypassed_non_tauri_runtime",
      redactUpstreamProxy({ upstreamProxy: input.settings }),
    );
    return {
      success: false,
      elapsedMs: 0,
      error: "Upstream proxy testing requires the desktop runtime.",
      probeTarget: `${input.probeHost ?? "www.apple.com"}:${input.probePort ?? 443}`,
    };
  }

  try {
    logDevInfo("ui.commands", "test_upstream_proxy_requested", {
      protocol: input.settings.protocol,
      host: input.settings.host,
      port: input.settings.port,
      authenticated: Boolean(input.settings.username),
    });
    const payload = await invoke<unknown>("test_upstream_proxy", { input });
    const result = parseUpstreamProxyProbeResult(payload);

    logDevInfo("ui.commands", "test_upstream_proxy_succeeded", {
      success: result.success,
      elapsedMs: result.elapsedMs,
    });

    return result;
  } catch (error) {
    reportCommandFailure("test_upstream_proxy", error);
    throw coerceAppError(error);
  }
}

export async function loadDefaultSslProxyingExclusions(): Promise<string[]> {
  if (!isTauriRuntime()) {
    logDevDebug(
      "ui.commands",
      "load_default_ssl_proxying_exclusions_bypassed_non_tauri_runtime",
    );
    return parseSslProxyingExclusions([
      "*.tiktokv.com",
      "*.tiktokcdn.com",
      "*.tiktok-row.net",
      "*.snssdk.com",
      "*.byteoversea.com",
      "*.icloud.com",
      "*.icloud.com.cn",
      "apps.apple.com",
      "*.apps.apple.com",
      "itunes.apple.com",
      "*.itunes.apple.com",
    ]);
  }

  try {
    logDevInfo("ui.commands", "load_default_ssl_proxying_exclusions_requested");
    const payload = await invoke<unknown>("default_ssl_proxying_exclusions");
    const exclusions = parseSslProxyingExclusions(payload);

    logDevInfo("ui.commands", "load_default_ssl_proxying_exclusions_succeeded", {
      count: exclusions.length,
    });

    return exclusions;
  } catch (error) {
    reportCommandFailure("default_ssl_proxying_exclusions", error);
    throw coerceAppError(error);
  }
}
