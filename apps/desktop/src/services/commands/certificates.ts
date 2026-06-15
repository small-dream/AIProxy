import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  parseAndroidAdbCertificateInstallResult,
  parseAndroidAdbDevices,
  parseAndroidAdbProxyResult,
  parseHarmonyHdcCertificateInstallResult,
  parseHarmonyHdcDevices,
  parseIOSSimulatorCertificateInstallResult,
  parseIOSSimulatorDevices,
  parseCertificateStatus,
  parseCertificateInstallGuide,
  parseSetupDiagnostic,
  type AndroidAdbDevice,
  type AndroidAdbCertificateInstallResult,
  type AndroidAdbProxyResult,
  type CertificateInstallGuide,
  type CertificateStatus,
  type ClearAndroidProxyViaAdbInput,
  type GenerateRootCertificateInput,
  type HarmonyHdcCertificateInstallResult,
  type HarmonyHdcDevice,
  type InstallAndroidCertificateViaAdbInput,
  type InstallHarmonyCertificateViaHdcInput,
  type InstallIosCertificateViaSimulatorInput,
  type IOSSimulatorCertificateInstallResult,
  type IOSSimulatorDevice,
  type SetAndroidProxyViaAdbInput,
  type SetupDiagnostic,
} from "@aiproxy/shared-types";

import { logDevDebug, logDevInfo } from "@/services/logger/dev-logger";

import {
  detectBrowserPlatform,
  isTauriRuntime,
  reportCommandFailure,
  withTimeout,
} from "./runtime";

const MOBILE_DEVICE_SCAN_TIMEOUT_MS = 8_000;

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

export async function diagnoseCertificateSetup(): Promise<SetupDiagnostic> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "diagnose_certificate_setup_bypassed_non_tauri_runtime");
    return {
      platform: detectBrowserPlatform(),
      certPresent: false,
      certTrusted: false,
      adbAvailable: false,
      hdcAvailable: false,
      iosSimulatorTooling: false,
      checks: [],
    };
  }

  try {
    logDevInfo("ui.commands", "diagnose_certificate_setup_requested");
    const payload = await invoke<unknown>("diagnose_certificate_setup");
    const diagnostic = parseSetupDiagnostic(payload);

    logDevDebug("ui.commands", "diagnose_certificate_setup_succeeded", {
      platform: diagnostic.platform,
      certPresent: diagnostic.certPresent,
      certTrusted: diagnostic.certTrusted,
    });

    return diagnostic;
  } catch (error) {
    reportCommandFailure("diagnose_certificate_setup", error);
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
    const payload = await withTimeout(
      invoke<unknown>("list_android_adb_devices"),
      MOBILE_DEVICE_SCAN_TIMEOUT_MS,
      "Timed out while scanning Android devices via adb. Check that adb is responsive, then refresh devices.",
    );
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
    logDevDebug(
      "ui.commands",
      "install_android_certificate_via_adb_bypassed_non_tauri_runtime",
      input,
    );
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
    const payload = await withTimeout(
      invoke<unknown>("list_ios_simulators"),
      MOBILE_DEVICE_SCAN_TIMEOUT_MS,
      "Timed out while scanning iOS Simulators. Check Xcode Simulator services, then refresh simulators.",
    );
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
    logDevDebug(
      "ui.commands",
      "install_ios_certificate_via_simulator_bypassed_non_tauri_runtime",
      input,
    );
    return {
      success: true,
      simulatorName: "iPhone 16 Pro",
      simulatorUdid: input?.simulatorUdid ?? "F6D7A4D8-62A0-4FD7-9B53-1234567890AB",
    };
  }

  try {
    logDevInfo("ui.commands", "install_ios_certificate_via_simulator_requested", input);
    const payload = await invoke<unknown>("install_ios_certificate_via_simulator", {
      input: input
        ? { ...(input.simulatorUdid ? { simulatorUdid: input.simulatorUdid } : {}) }
        : {},
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

export async function listHarmonyHdcDevices(): Promise<HarmonyHdcDevice[]> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "list_harmony_hdc_devices_bypassed_non_tauri_runtime");
    return [
      {
        serial: "50051abcdefg",
        state: "Connected",
        model: "HarmonyOS Device",
      },
    ];
  }

  try {
    logDevInfo("ui.commands", "list_harmony_hdc_devices_requested");
    const payload = await withTimeout(
      invoke<unknown>("list_harmony_hdc_devices"),
      MOBILE_DEVICE_SCAN_TIMEOUT_MS,
      "Timed out while scanning HarmonyOS devices via hdc. Check that hdc is responsive, then refresh devices.",
    );
    const devices = parseHarmonyHdcDevices(payload);

    logDevInfo("ui.commands", "list_harmony_hdc_devices_succeeded", {
      deviceCount: devices.length,
    });

    return devices;
  } catch (error) {
    reportCommandFailure("list_harmony_hdc_devices", error);
    throw coerceAppError(error);
  }
}

export async function installHarmonyCertificateViaHdc(
  input?: InstallHarmonyCertificateViaHdcInput,
): Promise<HarmonyHdcCertificateInstallResult> {
  if (!isTauriRuntime()) {
    logDevDebug(
      "ui.commands",
      "install_harmony_certificate_via_hdc_bypassed_non_tauri_runtime",
      input,
    );
    return {
      success: true,
      deviceSerial: input?.deviceSerial ?? "50051abcdefg",
      remotePath: "/data/local/tmp/aiproxy-root-ca.cer",
    };
  }

  try {
    logDevInfo("ui.commands", "install_harmony_certificate_via_hdc_requested", input);
    const payload = await invoke<unknown>("install_harmony_certificate_via_hdc", {
      input: input ? { ...(input.deviceSerial ? { deviceSerial: input.deviceSerial } : {}) } : {},
    });
    const result = parseHarmonyHdcCertificateInstallResult(payload);

    logDevInfo("ui.commands", "install_harmony_certificate_via_hdc_succeeded", {
      deviceSerial: result.deviceSerial,
      remotePath: result.remotePath,
    });

    return result;
  } catch (error) {
    reportCommandFailure("install_harmony_certificate_via_hdc", error);
    throw coerceAppError(error);
  }
}
