import { invoke } from "@tauri-apps/api/core";
import {
  coerceAppError,
  createDefaultProxyStatus,
  createMockComposeSessionDetail,
  DEFAULT_WORKSPACE_ID,
  parseAndroidAdbCertificateInstallResult,
  parseAndroidAdbDevices,
  parseAndroidAdbProxyResult,
  parseDnsMappings,
  parseIOSSimulatorCertificateInstallResult,
  parseIOSSimulatorDevices,
  parseMapRules,
  parseBreakpointRules,
  parseCertificateStatus,
  parseCertificateInstallGuide,
  parseSessionDetailContentPatch,
  parseRewriteRules,
  parseScriptRules,
  parseScriptSessionTrace,
  parseScriptSourceFile,
  parseSessionDetail,
  mergeSessionDetailContent,
  normalizeStartProxyInput,
  parseSessionSummaries,
  parseProxyStatus,
  parseThrottleProfiles,
  parseWorkspace,
  parseWorkspaces,
  parseWsMessages,
  type BreakpointResolution,
  type BreakpointRule,
  type AndroidAdbDevice,
  type AndroidAdbCertificateInstallResult,
  type AndroidAdbProxyResult,
  type CertificateInstallGuide,
  type CertificateStatus,
  type ClearAndroidProxyViaAdbInput,
  type ComposedRequestInput,
  type DnsMappingRule,
  type GenerateRootCertificateInput,
  type InstallAndroidCertificateViaAdbInput,
  type InstallIosCertificateViaSimulatorInput,
  type IOSSimulatorCertificateInstallResult,
  type IOSSimulatorDevice,
  type MapRule,
  type ProxyStatus,
  type RewriteRule,
  type ScriptRule,
  type ScriptSessionTrace,
  type ScriptSourceFile,
  type SessionDetail,
  type SessionDetailContentPatch,
  type SessionDetailContentRequest,
  type SessionSummary,
  type SetAndroidProxyViaAdbInput,
  type StartProxyInput,
  type StopProxyInput,
  type ThrottleProfile,
  type WsMessage,
  type Workspace,
  type ApiCollection,
  type ApiCollectionItem,
  type ApiEnvironment,
  type ApiEnvironmentVariable,
  parseApiCollections,
  parseApiCollectionItem,
  parseApiCollectionItems,
  parseApiEnvironments,
  parseApiEnvironmentVariables,
  type CollectionSaveInput,
  type SessionToCollectionInput,
  type BatchExecuteInput,
} from "@aiproxy/shared-types";

import {
  logDevDebug,
  logDevError,
  logDevInfo,
} from "@/services/logger/dev-logger";

const REWRITE_RULES_STORAGE_KEY = "aiproxy.rules.rewrite";
const MAP_RULES_STORAGE_KEY = "aiproxy.rules.map";
const THROTTLE_PROFILES_STORAGE_KEY = "aiproxy.throttle.profiles";
const DNS_MAPPINGS_STORAGE_KEY = "aiproxy.rules.dns";
const SCRIPT_RULES_STORAGE_KEY = "aiproxy.rules.script";

export {
  getWsConnectionStatus,
  injectWsMessage,
  listWsMessages,
} from "./ws";

export async function getBootstrapStatus(): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "get_bootstrap_status_bypassed_non_tauri_runtime");
    return createDefaultProxyStatus();
  }

  try {
    logDevInfo("ui.commands", "get_bootstrap_status_requested");
    const payload = await invoke<unknown>("get_bootstrap_status");
    const status = parseProxyStatus(payload);

    logDevDebug("ui.commands", "get_bootstrap_status_succeeded", {
      port: status.port,
      running: status.running,
      systemProxyEnabled: status.systemProxyEnabled,
    });

    return status;
  } catch (error) {
    reportCommandFailure("get_bootstrap_status", error);
    throw coerceAppError(error);
  }
}

export async function startProxy(input: StartProxyInput): Promise<ProxyStatus> {
  const normalizedInput = normalizeStartProxyInput(input);

  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "start_proxy_bypassed_non_tauri_runtime", normalizedInput);
    return {
      ...createDefaultProxyStatus(),
      port: normalizedInput.port ?? createDefaultProxyStatus().port,
      running: true,
      sslEnabled: normalizedInput.enableSsl ?? false,
      startedAt: new Date().toISOString(),
      activeWorkspaceId: normalizedInput.workspaceId,
    };
  }

  try {
    logDevInfo("ui.commands", "start_proxy_requested", normalizedInput);
    const payload = await invoke<unknown>("start_proxy", {
      input: normalizedInput,
    });
    const status = parseProxyStatus(payload);

    logDevInfo("ui.commands", "start_proxy_succeeded", {
      port: status.port,
      running: status.running,
      workspaceId: status.activeWorkspaceId,
    });

    return status;
  } catch (error) {
    reportCommandFailure("start_proxy", error, normalizedInput.workspaceId);
    throw coerceAppError(error);
  }
}

export async function stopProxy(input: StopProxyInput): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "stop_proxy_bypassed_non_tauri_runtime", input);
    return createDefaultProxyStatus();
  }

  try {
    logDevInfo("ui.commands", "stop_proxy_requested", input);
    const payload = await invoke<unknown>("stop_proxy", { input });
    const status = parseProxyStatus(payload);

    logDevInfo("ui.commands", "stop_proxy_succeeded", {
      running: status.running,
      workspaceId: status.activeWorkspaceId,
    });

    return status;
  } catch (error) {
    reportCommandFailure("stop_proxy", error, input.workspaceId);
    throw coerceAppError(error);
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_sessions_bypassed_non_tauri_runtime");
    return [];
  }

  try {
    logDevDebug("ui.commands", "list_sessions_requested");
    const payload = await invoke<unknown>("list_sessions");
    const sessions = parseSessionSummaries(payload);

    logDevDebug("ui.commands", "list_sessions_succeeded", {
      sessionCount: sessions.length,
    });

    return sessions;
  } catch (error) {
    reportCommandFailure("list_sessions", error);
    throw coerceAppError(error);
  }
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Session detail requires the Tauri desktop runtime.",
    };
  }

  try {
    logDevDebug("ui.commands", "get_session_detail_requested", {
      sessionId,
    });
    const payload = await invoke<unknown>("get_session_detail", {
      input: { sessionId },
    });
    const detail = parseSessionDetail(payload);

    logDevDebug("ui.commands", "get_session_detail_succeeded", {
      sessionId: detail.id,
      statusCode: detail.summary.statusCode,
    });

    return detail;
  } catch (error) {
    reportCommandFailure("get_session_detail", error);
    throw coerceAppError(error);
  }
}

export async function getSessionDetailContent(
  input: SessionDetailContentRequest,
): Promise<SessionDetailContentPatch> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Session detail content requires the Tauri desktop runtime.",
    };
  }

  try {
    logDevDebug("ui.commands", "get_session_detail_content_requested", input);
    const payload = await invoke<unknown>("get_session_detail_content", {
      input,
    });
    const patch = parseSessionDetailContentPatch(payload);

    logDevDebug("ui.commands", "get_session_detail_content_succeeded", {
      sessionId: patch.sessionId,
    });

    return patch;
  } catch (error) {
    reportCommandFailure("get_session_detail_content", error);
    throw coerceAppError(error);
  }
}

export async function getSessionDetailWithContent(
  sessionId: string,
  contentRequest: Omit<SessionDetailContentRequest, "sessionId">,
): Promise<SessionDetail> {
  const detail = await getSessionDetail(sessionId);
  const patch = await getSessionDetailContent({
    sessionId,
    ...contentRequest,
  });

  return mergeSessionDetailContent(detail, patch);
}

export async function clearSessions(): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "clear_sessions_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "clear_sessions_requested");
    await invoke("clear_sessions");
    logDevInfo("ui.commands", "clear_sessions_succeeded");
  } catch (error) {
    reportCommandFailure("clear_sessions", error);
    throw coerceAppError(error);
  }
}

export async function searchWsMessages(
  sessionId: string,
  query: string,
  limit?: number,
  offset?: number,
): Promise<WsMessage[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "search_ws_messages_bypassed_non_tauri_runtime");
    return [];
  }

  try {
    const payload = await invoke<unknown>("search_ws_messages", {
      input: { sessionId, query, limit, offset },
    });
    return parseWsMessages(payload);
  } catch (error) {
    reportCommandFailure("search_ws_messages", error);
    throw coerceAppError(error);
  }
}

export async function deleteSessionsExcept(keepSessionId: string): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "delete_sessions_except_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "delete_sessions_except_requested", { keepSessionId });
    await invoke("delete_sessions_except", {
      input: { keepSessionId },
    });
    logDevInfo("ui.commands", "delete_sessions_except_succeeded");
  } catch (error) {
    reportCommandFailure("delete_sessions_except", error);
    throw coerceAppError(error);
  }
}

export async function setFocusedHosts(hosts: string[]): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "set_focused_hosts_bypassed_non_tauri_runtime", { hosts });
    return;
  }

  try {
    logDevDebug("ui.commands", "set_focused_hosts_requested", { hosts });
    await invoke("set_focused_hosts", {
      input: { hosts },
    });
    logDevDebug("ui.commands", "set_focused_hosts_succeeded", { hosts });
  } catch (error) {
    reportCommandFailure("set_focused_hosts", error);
    throw coerceAppError(error);
  }
}

export async function enableSystemProxy(): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "enable_system_proxy_bypassed_non_tauri_runtime");
    return {
      ...createDefaultProxyStatus(),
      systemProxyEnabled: true,
    };
  }

  try {
    logDevInfo("ui.commands", "enable_system_proxy_requested");
    const payload = await invoke<unknown>("enable_system_proxy");
    const status = parseProxyStatus(payload);

    logDevInfo("ui.commands", "enable_system_proxy_succeeded", {
      port: status.port,
      systemProxyEnabled: status.systemProxyEnabled,
    });

    return status;
  } catch (error) {
    reportCommandFailure("enable_system_proxy", error);
    throw coerceAppError(error);
  }
}

export async function disableSystemProxy(): Promise<ProxyStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "disable_system_proxy_bypassed_non_tauri_runtime");
    return createDefaultProxyStatus();
  }

  try {
    logDevInfo("ui.commands", "disable_system_proxy_requested");
    const payload = await invoke<unknown>("disable_system_proxy");
    const status = parseProxyStatus(payload);

    logDevInfo("ui.commands", "disable_system_proxy_succeeded", {
      port: status.port,
      systemProxyEnabled: status.systemProxyEnabled,
    });

    return status;
  } catch (error) {
    reportCommandFailure("disable_system_proxy", error);
    throw coerceAppError(error);
  }
}

export async function getCertificateStatus(): Promise<CertificateStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "get_certificate_status_bypassed_non_tauri_runtime");
    return { trusted: false, platform: detectBrowserPlatform() };
  }

  try {
    logDevInfo("ui.commands", "get_certificate_status_requested");
    const payload = await invoke<unknown>("get_certificate_status");
    const status = parseCertificateStatus(payload);

    logDevDebug("ui.commands", "get_certificate_status_succeeded", {
      trusted: status.trusted,
      platform: status.platform,
    });

    return status;
  } catch (error) {
    reportCommandFailure("get_certificate_status", error);
    throw coerceAppError(error);
  }
}

export async function generateRootCertificate(
  input?: GenerateRootCertificateInput,
): Promise<CertificateStatus> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "generate_root_certificate_bypassed_non_tauri_runtime");
    return {
      trusted: false,
      platform: detectBrowserPlatform(),
      certPath: "/tmp/aiproxy-test-cert.pem",
      fingerprint: "AA:BB:CC:DD",
    };
  }

  try {
    logDevInfo("ui.commands", "generate_root_certificate_requested");
    const payload = await invoke<unknown>("generate_root_certificate", {
      input: { forceRegenerate: input?.forceRegenerate ?? false },
    });
    const status = parseCertificateStatus(payload);

    logDevInfo("ui.commands", "generate_root_certificate_succeeded", {
      trusted: status.trusted,
      fingerprint: status.fingerprint,
    });

    return status;
  } catch (error) {
    reportCommandFailure("generate_root_certificate", error);
    throw coerceAppError(error);
  }
}

export async function launchCertificateInstaller(): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "launch_certificate_installer_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "launch_certificate_installer_requested");
    await invoke("launch_certificate_installer");
    logDevInfo("ui.commands", "launch_certificate_installer_succeeded");
  } catch (error) {
    reportCommandFailure("launch_certificate_installer", error);
    throw coerceAppError(error);
  }
}

export async function openCertificateInstallGuide(): Promise<CertificateInstallGuide> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "open_certificate_install_guide_bypassed_non_tauri_runtime");
    return {
      success: true,
      certPath: "/tmp/aiproxy-test-cert.pem",
      platform: detectBrowserPlatform(),
      steps: [
        { order: 1, description: "Open Certificate Manager" },
        { order: 2, description: "Import the certificate" },
      ],
    };
  }

  try {
    logDevInfo("ui.commands", "open_certificate_install_guide_requested");
    const payload = await invoke<unknown>("open_certificate_install_guide");
    const guide = parseCertificateInstallGuide(payload);

    logDevInfo("ui.commands", "open_certificate_install_guide_succeeded", {
      platform: guide.platform,
      stepCount: guide.steps.length,
    });

    return guide;
  } catch (error) {
    reportCommandFailure("open_certificate_install_guide", error);
    throw coerceAppError(error);
  }
}

export async function listAndroidAdbDevices(): Promise<AndroidAdbDevice[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_android_adb_devices_bypassed_non_tauri_runtime");
    return [
      {
        serial: "emulator-5554",
        state: "device",
        model: "Android Emulator",
        transportId: "1",
      },
      {
        serial: "R58N123456A",
        state: "device",
        model: "Pixel 8",
        transportId: "2",
      },
    ];
  }

  try {
    logDevInfo("ui.commands", "list_android_adb_devices_requested");
    const payload = await invoke<unknown>("list_android_adb_devices");
    const devices = parseAndroidAdbDevices(payload);

    logDevInfo("ui.commands", "list_android_adb_devices_succeeded", {
      deviceCount: devices.length,
    });

    return devices;
  } catch (error) {
    reportCommandFailure("list_android_adb_devices", error);
    throw coerceAppError(error);
  }
}

export async function installAndroidCertificateViaAdb(
  input?: InstallAndroidCertificateViaAdbInput,
): Promise<AndroidAdbCertificateInstallResult> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "install_android_certificate_via_adb_bypassed_non_tauri_runtime", input);
    return {
      success: true,
      deviceSerial: input?.deviceSerial ?? "emulator-5554",
      remotePath: "/sdcard/Download/aiproxy-root-ca.cer",
    };
  }

  try {
    logDevInfo("ui.commands", "install_android_certificate_via_adb_requested", input);
    const payload = await invoke<unknown>("install_android_certificate_via_adb", {
      input: input ? { ...(input.deviceSerial ? { deviceSerial: input.deviceSerial } : {}) } : {},
    });
    const result = parseAndroidAdbCertificateInstallResult(payload);

    logDevInfo("ui.commands", "install_android_certificate_via_adb_succeeded", {
      deviceSerial: result.deviceSerial,
      remotePath: result.remotePath,
    });

    return result;
  } catch (error) {
    reportCommandFailure("install_android_certificate_via_adb", error);
    throw coerceAppError(error);
  }
}

export async function listIosSimulators(): Promise<IOSSimulatorDevice[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_ios_simulators_bypassed_non_tauri_runtime");
    return [
      {
        name: "iPhone 16 Pro",
        runtime: "iOS 18.0",
        state: "Booted",
        udid: "F6D7A4D8-62A0-4FD7-9B53-1234567890AB",
      },
    ];
  }

  try {
    logDevInfo("ui.commands", "list_ios_simulators_requested");
    const payload = await invoke<unknown>("list_ios_simulators");
    const simulators = parseIOSSimulatorDevices(payload);

    logDevInfo("ui.commands", "list_ios_simulators_succeeded", {
      simulatorCount: simulators.length,
    });

    return simulators;
  } catch (error) {
    reportCommandFailure("list_ios_simulators", error);
    throw coerceAppError(error);
  }
}

export async function installIosCertificateViaSimulator(
  input?: InstallIosCertificateViaSimulatorInput,
): Promise<IOSSimulatorCertificateInstallResult> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "install_ios_certificate_via_simulator_bypassed_non_tauri_runtime", input);
    return {
      success: true,
      simulatorName: "iPhone 16 Pro",
      simulatorUdid: input?.simulatorUdid ?? "F6D7A4D8-62A0-4FD7-9B53-1234567890AB",
    };
  }

  try {
    logDevInfo("ui.commands", "install_ios_certificate_via_simulator_requested", input);
    const payload = await invoke<unknown>("install_ios_certificate_via_simulator", {
      input: input ? { ...(input.simulatorUdid ? { simulatorUdid: input.simulatorUdid } : {}) } : {},
    });
    const result = parseIOSSimulatorCertificateInstallResult(payload);

    logDevInfo("ui.commands", "install_ios_certificate_via_simulator_succeeded", {
      simulatorName: result.simulatorName,
      simulatorUdid: result.simulatorUdid,
    });

    return result;
  } catch (error) {
    reportCommandFailure("install_ios_certificate_via_simulator", error, input?.simulatorUdid);
    throw coerceAppError(error);
  }
}

export async function setAndroidProxyViaAdb(
  input: SetAndroidProxyViaAdbInput,
): Promise<AndroidAdbProxyResult> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "set_android_proxy_via_adb_bypassed_non_tauri_runtime", input);
    return {
      success: true,
      deviceSerial: input.deviceSerial ?? "emulator-5554",
      proxyAddress: `${input.host}:${input.port}`,
    };
  }

  try {
    logDevInfo("ui.commands", "set_android_proxy_via_adb_requested", input);
    const payload = await invoke<unknown>("set_android_proxy_via_adb", {
      input: {
        ...(input.deviceSerial ? { deviceSerial: input.deviceSerial } : {}),
        host: input.host,
        port: input.port,
      },
    });
    const result = parseAndroidAdbProxyResult(payload);

    logDevInfo("ui.commands", "set_android_proxy_via_adb_succeeded", {
      deviceSerial: result.deviceSerial,
      proxyAddress: result.proxyAddress,
    });

    return result;
  } catch (error) {
    reportCommandFailure("set_android_proxy_via_adb", error, input.deviceSerial);
    throw coerceAppError(error);
  }
}

export async function clearAndroidProxyViaAdb(
  input?: ClearAndroidProxyViaAdbInput,
): Promise<AndroidAdbProxyResult> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "clear_android_proxy_via_adb_bypassed_non_tauri_runtime", input);
    return {
      success: true,
      deviceSerial: input?.deviceSerial ?? "emulator-5554",
    };
  }

  try {
    logDevInfo("ui.commands", "clear_android_proxy_via_adb_requested", input);
    const payload = await invoke<unknown>("clear_android_proxy_via_adb", {
      input: input ? { ...(input.deviceSerial ? { deviceSerial: input.deviceSerial } : {}) } : {},
    });
    const result = parseAndroidAdbProxyResult(payload);

    logDevInfo("ui.commands", "clear_android_proxy_via_adb_succeeded", {
      deviceSerial: result.deviceSerial,
    });

    return result;
  } catch (error) {
    reportCommandFailure("clear_android_proxy_via_adb", error, input?.deviceSerial);
    throw coerceAppError(error);
  }
}

export async function sendComposedRequest(input: ComposedRequestInput): Promise<SessionDetail> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "send_composed_request_bypassed_non_tauri_runtime");
    return createMockComposeSessionDetail(input);
  }

  try {
    logDevInfo("ui.commands", "send_composed_request_requested", { url: input.url, method: input.method });
    const payload = await invoke<unknown>("send_composed_request", { input });
    const detail = parseSessionDetail(payload);

    logDevInfo("ui.commands", "send_composed_request_succeeded", {
      sessionId: detail.id,
      statusCode: detail.summary.statusCode,
    });

    return detail;
  } catch (error) {
    reportCommandFailure("send_composed_request", error);
    throw coerceAppError(error);
  }
}

export async function getLocalIp(): Promise<string[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "get_local_ip_bypassed_non_tauri_runtime");
    return ["192.168.1.100"];
  }

  try {
    logDevInfo("ui.commands", "get_local_ip_requested");
    const ips = await invoke<string[]>("get_local_ip");

    logDevInfo("ui.commands", "get_local_ip_succeeded", { ips });

    return ips;
  } catch (error) {
    reportCommandFailure("get_local_ip", error);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// Breakpoint commands
// ---------------------------------------------------------------------------

export async function listBreakpointRules(): Promise<BreakpointRule[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_breakpoint_rules_bypassed_non_tauri_runtime");
    return [];
  }

  try {
    logDevDebug("ui.commands", "list_breakpoint_rules_requested");
    const payload = await invoke<unknown>("list_breakpoint_rules");
    const rules = parseBreakpointRules(payload);
    logDevDebug("ui.commands", "list_breakpoint_rules_succeeded", { count: rules.length });
    return rules;
  } catch (error) {
    reportCommandFailure("list_breakpoint_rules", error);
    throw coerceAppError(error);
  }
}

export async function setBreakpointRules(rules: BreakpointRule[]): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "set_breakpoint_rules_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "set_breakpoint_rules_requested", { count: rules.length });
    await invoke("set_breakpoint_rules", { rules });
    logDevInfo("ui.commands", "set_breakpoint_rules_succeeded");
  } catch (error) {
    reportCommandFailure("set_breakpoint_rules", error);
    throw coerceAppError(error);
  }
}

export async function resolveBreakpoint(resolution: BreakpointResolution): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "resolve_breakpoint_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "resolve_breakpoint_requested", { sessionId: resolution.sessionId, action: resolution.action });
    await invoke("resolve_breakpoint", { resolution });
    logDevInfo("ui.commands", "resolve_breakpoint_succeeded");
  } catch (error) {
    reportCommandFailure("resolve_breakpoint", error);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// Rewrite / Map / Throttling commands
// ---------------------------------------------------------------------------

export async function listRewriteRules(workspaceId = DEFAULT_WORKSPACE_ID): Promise<RewriteRule[]> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_rewrite_rules", {
        input: { workspaceId },
      });

      return parseRewriteRules(payload);
    } catch (error) {
      reportCommandFailure("list_rewrite_rules", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return readStoredRules(REWRITE_RULES_STORAGE_KEY, parseRewriteRules).filter((rule) => rule.workspaceId === workspaceId);
}

export async function saveRewriteRule(
  input: Omit<RewriteRule, "id"> & { id?: string },
): Promise<RewriteRule> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("save_rewrite_rule", {
        input,
      });

      const [savedRule] = parseRewriteRules([payload]);
      return savedRule!;
    } catch (error) {
      reportCommandFailure("save_rewrite_rule", error, input.workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const rules = readStoredRules(REWRITE_RULES_STORAGE_KEY, parseRewriteRules);
  const nextRule = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as RewriteRule;

  writeStoredRules(REWRITE_RULES_STORAGE_KEY, upsertStoredEntity(rules, nextRule));

  return nextRule;
}

export async function listMapRules(input?: {
  mode?: MapRule["mode"];
  workspaceId?: string;
}): Promise<MapRule[]> {
  const workspaceId = input?.workspaceId ?? DEFAULT_WORKSPACE_ID;

  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_map_rules", {
        input: {
          workspaceId,
          ...(input?.mode ? { mode: input.mode } : {}),
        },
      });

      return parseMapRules(payload);
    } catch (error) {
      reportCommandFailure("list_map_rules", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return readStoredRules(MAP_RULES_STORAGE_KEY, parseMapRules).filter((rule) => {
    if (rule.workspaceId !== workspaceId) {
      return false;
    }

    return input?.mode ? rule.mode === input.mode : true;
  });
}

export async function saveMapRule(input: Omit<MapRule, "id"> & { id?: string }): Promise<MapRule> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("save_map_rule", {
        input,
      });

      const [savedRule] = parseMapRules([payload]);
      return savedRule!;
    } catch (error) {
      reportCommandFailure("save_map_rule", error, input.workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const rules = readStoredRules(MAP_RULES_STORAGE_KEY, parseMapRules);
  const nextRule = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as MapRule;

  writeStoredRules(MAP_RULES_STORAGE_KEY, upsertStoredEntity(rules, nextRule));

  return nextRule;
}

export async function listScriptRules(workspaceId = DEFAULT_WORKSPACE_ID): Promise<ScriptRule[]> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_script_rules", {
        input: { workspaceId },
      });

      return parseScriptRules(payload);
    } catch (error) {
      reportCommandFailure("list_script_rules", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return readStoredRules(SCRIPT_RULES_STORAGE_KEY, parseScriptRules).filter((rule) => rule.workspaceId === workspaceId);
}

export async function saveScriptRule(
  input: Omit<ScriptRule, "id"> & { id?: string },
): Promise<ScriptRule> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("save_script_rule", { input });
      const [savedRule] = parseScriptRules([payload]);
      return savedRule!;
    } catch (error) {
      reportCommandFailure("save_script_rule", error, input.workspaceId);
      throw coerceAppError(error);
    }
  }

  const rules = readStoredRules(SCRIPT_RULES_STORAGE_KEY, parseScriptRules);
  const nextRule = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as ScriptRule;

  writeStoredRules(SCRIPT_RULES_STORAGE_KEY, upsertStoredEntity(rules, nextRule));
  return nextRule;
}

export async function readScriptSourceFile(path: string): Promise<ScriptSourceFile> {
  if (!isTauriRuntime()) {
    throw {
      code: "DESKTOP_RUNTIME_REQUIRED",
      message: "Reading script files requires the Tauri desktop runtime.",
    };
  }

  try {
    const payload = await invoke<unknown>("read_script_source_file", {
      input: { path },
    });
    return parseScriptSourceFile(payload);
  } catch (error) {
    reportCommandFailure("read_script_source_file", error, path);
    throw coerceAppError(error);
  }
}

export async function listScriptSessionTrace(sessionId: string): Promise<ScriptSessionTrace[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  try {
    const payload = await invoke<unknown>("list_script_session_trace", {
      input: { sessionId },
    });
    return parseScriptSessionTrace(payload);
  } catch (error) {
    reportCommandFailure("list_script_session_trace", error, sessionId);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// DNS Mappings
// ---------------------------------------------------------------------------

export async function listDnsMappings(input: { workspaceId: string }): Promise<DnsMappingRule[]> {
  if (isTauriRuntime()) {
    try {
      const result = await invoke("list_dns_mappings", { input });
      return parseDnsMappings(result);
    } catch (error) {
      reportCommandFailure("list_dns_mappings", error);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  return readStoredRules(DNS_MAPPINGS_STORAGE_KEY, parseDnsMappings)
    .filter((rule) => rule.workspaceId === input.workspaceId);
}

export async function saveDnsMapping(input: Omit<DnsMappingRule, "id"> & { id?: string }): Promise<DnsMappingRule> {
  if (isTauriRuntime()) {
    try {
      const result = await invoke("save_dns_mapping", { input });
      const parsed = parseDnsMappings([result]);
      if (parsed.length === 0) throw coerceAppError("empty result from save_dns_mapping");
      return parsed[0]!;
    } catch (error) {
      reportCommandFailure("save_dns_mapping", error);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const rules = readStoredRules(DNS_MAPPINGS_STORAGE_KEY, parseDnsMappings);
  const nextRule = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  } as DnsMappingRule;

  writeStoredRules(DNS_MAPPINGS_STORAGE_KEY, upsertStoredEntity(rules, nextRule));

  return nextRule;
}

export async function deleteRule(input: {
  ruleId: string;
  ruleType: "rewrite" | "map" | "dns" | "script";
}): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await invoke("delete_rule", {
        input,
      });
      return;
    } catch (error) {
      reportCommandFailure("delete_rule", error);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  if (input.ruleType === "rewrite") {
    writeStoredRules(
      REWRITE_RULES_STORAGE_KEY,
      readStoredRules(REWRITE_RULES_STORAGE_KEY, parseRewriteRules).filter((rule) => rule.id !== input.ruleId),
    );
    return;
  }

  if (input.ruleType === "dns") {
    writeStoredRules(
      DNS_MAPPINGS_STORAGE_KEY,
      readStoredRules(DNS_MAPPINGS_STORAGE_KEY, parseDnsMappings).filter((rule) => rule.id !== input.ruleId),
    );
    return;
  }

  if (input.ruleType === "script") {
    writeStoredRules(
      SCRIPT_RULES_STORAGE_KEY,
      readStoredRules(SCRIPT_RULES_STORAGE_KEY, parseScriptRules).filter((rule) => rule.id !== input.ruleId),
    );
    return;
  }

  writeStoredRules(
    MAP_RULES_STORAGE_KEY,
    readStoredRules(MAP_RULES_STORAGE_KEY, parseMapRules).filter((rule) => rule.id !== input.ruleId),
  );
}

export async function listThrottleProfiles(workspaceId = DEFAULT_WORKSPACE_ID): Promise<ThrottleProfile[]> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("list_throttle_profiles", {
        input: { workspaceId },
      });

      return parseThrottleProfiles(payload);
    } catch (error) {
      reportCommandFailure("list_throttle_profiles", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const storedProfiles = readStoredRules(THROTTLE_PROFILES_STORAGE_KEY, parseThrottleProfiles);

  if (storedProfiles.length === 0) {
    const defaults = createDefaultThrottleProfiles(workspaceId);
    writeStoredRules(THROTTLE_PROFILES_STORAGE_KEY, defaults);
    return defaults;
  }

  return storedProfiles.filter((profile) => profile.workspaceId === workspaceId);
}

export async function saveThrottleProfile(
  input: Omit<ThrottleProfile, "id"> & { id?: string },
): Promise<ThrottleProfile> {
  if (isTauriRuntime()) {
    try {
      const payload = await invoke<unknown>("save_throttle_profile", {
        input,
      });

      const [savedProfile] = parseThrottleProfiles([payload]);
      return savedProfile!;
    } catch (error) {
      reportCommandFailure("save_throttle_profile", error, input.workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  const profiles = readStoredRules(THROTTLE_PROFILES_STORAGE_KEY, parseThrottleProfiles);
  const nextProfile: ThrottleProfile = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
  };
  const nextProfiles = upsertStoredEntity(profiles, nextProfile).map((profile) => ({
    ...profile,
    enabled: nextProfile.enabled ? profile.id === nextProfile.id : profile.enabled,
  }));

  writeStoredRules(THROTTLE_PROFILES_STORAGE_KEY, nextProfiles);

  return nextProfiles.find((profile) => profile.id === nextProfile.id) ?? nextProfile;
}

export async function setActiveThrottleProfile(input: {
  profileId?: string;
  workspaceId?: string;
}): Promise<void> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;

  if (isTauriRuntime()) {
    try {
      await invoke("set_active_throttle_profile", {
        input: {
          workspaceId,
          ...(input.profileId ? { profileId: input.profileId } : {}),
        },
      });
      return;
    } catch (error) {
      reportCommandFailure("set_active_throttle_profile", error, workspaceId);

      if (!shouldFallbackToLocalStore(error)) {
        throw coerceAppError(error);
      }
    }
  }

  writeStoredRules(
    THROTTLE_PROFILES_STORAGE_KEY,
    readStoredRules(THROTTLE_PROFILES_STORAGE_KEY, parseThrottleProfiles).map((profile) => {
      if (profile.workspaceId !== workspaceId) {
        return profile;
      }

      return {
        ...profile,
        enabled: profile.id === input.profileId,
      };
    }),
  );
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function detectBrowserPlatform(): "linux" | "macos" | "windows" {
  if (typeof navigator === "undefined") return "windows";
  const ua = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (ua.includes("linux") || platform.includes("linux")) return "linux";
  if (ua.includes("mac") || platform.includes("mac")) return "macos";
  return "windows";
}

function reportCommandFailure(commandName: string, error: unknown, workspaceId?: string) {
  logDevError("ui.commands", "command_failed", {
    commandName,
    error,
    occurredAt: new Date().toISOString(),
    workspaceId,
  });
}

function shouldFallbackToLocalStore(error: unknown): boolean {
  const normalized = coerceAppError(error);
  const message = normalized.message.toLowerCase();

  return (
    message.includes("not found") ||
    message.includes("unknown command") ||
    message.includes("failed to invoke") ||
    message.includes("command")
  );
}

function readStoredRules<T>(storageKey: string, parser: (value: unknown) => T[]): T[] {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return [];
  }

  const rawValue = window.localStorage.getItem(storageKey);

  if (!rawValue) {
    return [];
  }

  try {
    return parser(JSON.parse(rawValue));
  } catch (error) {
    reportCommandFailure(`read_local_store:${storageKey}`, error);
    return [];
  }
}

function writeStoredRules(storageKey: string, value: unknown) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(value));
}

function upsertStoredEntity<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);

  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item) => (item.id === nextItem.id ? nextItem : item));
}

function createDefaultThrottleProfiles(workspaceId: string): ThrottleProfile[] {
  return [
    {
      id: "preset-fast-4g",
      workspaceId,
      name: "Fast 4G",
      latencyMs: 80,
      uploadKbps: 1200,
      downloadKbps: 9000,
      packetLossRatio: 0.2,
      enabled: false,
      preset: true,
      note: "Balanced mobile profile for everyday app verification.",
    },
    {
      id: "preset-slow-3g",
      workspaceId,
      name: "Slow 3G",
      latencyMs: 300,
      uploadKbps: 320,
      downloadKbps: 768,
      packetLossRatio: 1.2,
      enabled: false,
      preset: true,
      note: "Useful for sign-in, skeleton loading, and retry validation.",
    },
    {
      id: "preset-lossy-wifi",
      workspaceId,
      name: "Lossy Wi-Fi",
      latencyMs: 45,
      uploadKbps: 6400,
      downloadKbps: 24000,
      packetLossRatio: 3.5,
      enabled: false,
      preset: true,
      note: "Good for reconnect logic and flaky LAN simulations.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Workspace commands
// ---------------------------------------------------------------------------

export async function listWorkspaces(): Promise<Workspace[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_workspaces_bypassed_non_tauri_runtime");
    return [
      {
        id: "default",
        name: "Default",
        proxyPort: 8888,
        sslEnabled: false,
        systemProxyEnabled: false,
        storagePath: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
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
}): Promise<Workspace> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "create_workspace_bypassed_non_tauri_runtime", input);
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      name: input.name,
      proxyPort: input.proxyPort,
      sslEnabled: input.sslEnabled ?? false,
      systemProxyEnabled: false,
      storagePath: "",
      createdAt: now,
      updatedAt: now,
    };
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
    return {
      id: workspaceId,
      name: workspaceId === "default" ? "Default" : workspaceId,
      proxyPort: 8888,
      sslEnabled: false,
      systemProxyEnabled: false,
      storagePath: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
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
}): Promise<Workspace> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "update_workspace_bypassed_non_tauri_runtime", input);
    return {
      id: input.workspaceId,
      name: input.name ?? "Default",
      proxyPort: input.proxyPort ?? 8888,
      sslEnabled: input.sslEnabled ?? false,
      systemProxyEnabled: false,
      storagePath: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
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

export async function listApiCollections(): Promise<ApiCollection[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  try {
    const payload = await invoke<unknown>("list_api_collections");
    return parseApiCollections(payload);
  } catch (error) {
    reportCommandFailure("list_api_collections", error);
    throw coerceAppError(error);
  }
}

export async function upsertApiCollection(input: {
  id?: string;
  parentId?: string | null;
  name: string;
  description?: string;
  sortOrder?: number;
}): Promise<ApiCollection> {
  if (!isTauriRuntime()) {
    return {
      id: input.id ?? crypto.randomUUID(),
      parentId: input.parentId ?? null,
      name: input.name,
      description: input.description ?? "",
      sortOrder: input.sortOrder ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const payload = await invoke<unknown>("upsert_api_collection", {
      input: { ...input, parentId: input.parentId ?? null },
    });
    const collections = parseApiCollections([payload]);
    const result = collections[0];
    if (!result) throw coerceAppError("Empty response");
    return result;
  } catch (error) {
    reportCommandFailure("upsert_api_collection", error);
    throw coerceAppError(error);
  }
}

export async function deleteApiCollection(id: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("delete_api_collection", { input: { id } });
  } catch (error) {
    reportCommandFailure("delete_api_collection", error, id);
    throw coerceAppError(error);
  }
}

export async function listApiCollectionItems(collectionId: string): Promise<ApiCollectionItem[]> {
  if (!isTauriRuntime()) return [];
  try {
    const payload = await invoke<unknown>("list_api_collection_items", {
      input: { collectionId },
    });
    return parseApiCollectionItems(payload);
  } catch (error) {
    reportCommandFailure("list_api_collection_items", error, collectionId);
    throw coerceAppError(error);
  }
}

export async function getApiCollectionItem(id: string): Promise<ApiCollectionItem> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Not available outside Tauri runtime");
  }
  try {
    const payload = await invoke<unknown>("get_api_collection_item", { input: { id } });
    return parseApiCollectionItem(payload);
  } catch (error) {
    reportCommandFailure("get_api_collection_item", error, id);
    throw coerceAppError(error);
  }
}

export async function upsertApiCollectionItem(
  input: CollectionSaveInput,
): Promise<ApiCollectionItem> {
  if (!isTauriRuntime()) {
    return {
      id: input.id ?? crypto.randomUUID(),
      collectionId: input.collectionId,
      name: input.name,
      description: input.description ?? "",
      sortOrder: 0,
      method: input.method,
      url: input.url,
      headers: input.headers,
      body: input.body,
      bodyType: input.bodyType,
      rawLanguage: input.rawLanguage,
      formData: input.formData,
      urlEncoded: input.urlEncoded,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const payload = await invoke<unknown>("upsert_api_collection_item", { input });
    return parseApiCollectionItem(payload);
  } catch (error) {
    reportCommandFailure("upsert_api_collection_item", error);
    throw coerceAppError(error);
  }
}

export async function deleteApiCollectionItem(id: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("delete_api_collection_item", { input: { id } });
  } catch (error) {
    reportCommandFailure("delete_api_collection_item", error, id);
    throw coerceAppError(error);
  }
}

export async function moveApiCollectionItem(
  id: string,
  targetCollectionId: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("move_api_collection_item", {
      input: { id, targetCollectionId },
    });
  } catch (error) {
    reportCommandFailure("move_api_collection_item", error, id);
    throw coerceAppError(error);
  }
}

export async function saveSessionToCollection(
  input: SessionToCollectionInput,
): Promise<ApiCollectionItem> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Not available outside Tauri runtime");
  }
  try {
    const payload = await invoke<unknown>("save_session_to_collection", { input });
    return parseApiCollectionItem(payload);
  } catch (error) {
    reportCommandFailure("save_session_to_collection", error, input.sessionId);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// API Environment commands
// ---------------------------------------------------------------------------

export async function listApiEnvironments(): Promise<ApiEnvironment[]> {
  if (!isTauriRuntime()) return [];
  try {
    const payload = await invoke<unknown>("list_api_environments");
    return parseApiEnvironments(payload);
  } catch (error) {
    reportCommandFailure("list_api_environments", error);
    throw coerceAppError(error);
  }
}

export async function upsertApiEnvironment(input: {
  id?: string;
  name: string;
  sortOrder?: number;
}): Promise<ApiEnvironment> {
  if (!isTauriRuntime()) {
    return {
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      sortOrder: input.sortOrder ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const payload = await invoke<unknown>("upsert_api_environment", { input });
    const envs = parseApiEnvironments([payload]);
    const result = envs[0];
    if (!result) throw coerceAppError("Empty response");
    return result;
  } catch (error) {
    reportCommandFailure("upsert_api_environment", error);
    throw coerceAppError(error);
  }
}

export async function deleteApiEnvironment(id: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("delete_api_environment", { input: { id } });
  } catch (error) {
    reportCommandFailure("delete_api_environment", error, id);
    throw coerceAppError(error);
  }
}

export async function listApiEnvironmentVariables(
  environmentId: string,
): Promise<ApiEnvironmentVariable[]> {
  if (!isTauriRuntime()) return [];
  try {
    const payload = await invoke<unknown>("list_api_environment_variables", {
      input: { environmentId },
    });
    return parseApiEnvironmentVariables(payload);
  } catch (error) {
    reportCommandFailure("list_api_environment_variables", error, environmentId);
    throw coerceAppError(error);
  }
}

export async function setApiEnvironmentVariables(
  environmentId: string,
  variables: Array<{
    id: string;
    key: string;
    value: string;
    enabled: boolean;
    sortOrder?: number;
  }>,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("set_api_environment_variables", {
      input: { environmentId, variables },
    });
  } catch (error) {
    reportCommandFailure("set_api_environment_variables", error, environmentId);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// Batch execute
// ---------------------------------------------------------------------------

export async function batchExecuteCollectionItems(
  input: BatchExecuteInput,
): Promise<SessionDetail[]> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Not available outside Tauri runtime");
  }
  try {
    const payload = await invoke<unknown[]>("batch_execute_collection_items", { input });
    return payload.map((item) => parseSessionDetail(item));
  } catch (error) {
    reportCommandFailure("batch_execute_collection_items", error);
    throw coerceAppError(error);
  }
}
