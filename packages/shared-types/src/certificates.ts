import { coerceAppError, isNullableString } from "./common";

export type CertificateStatus = {
  certPath?: string;
  fingerprint?: string;
  trusted: boolean;
  platform: "windows" | "macos" | "linux";
};

export type GenerateRootCertificateInput = {
  forceRegenerate?: boolean;
};

export type CertificateInstallGuide = {
  success: boolean;
  certPath: string;
  platform: string;
  steps: Array<{ order: number; description: string }>;
};

export type AndroidAdbCertificateInstallResult = {
  success: boolean;
  deviceSerial: string;
  remotePath: string;
};

export type AndroidAdbProxyResult = {
  success: boolean;
  deviceSerial: string;
  proxyAddress?: string;
};

export type AndroidAdbDevice = {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
};

export type IOSSimulatorDevice = {
  name: string;
  udid: string;
  state: string;
  runtime: string;
};

export type InstallAndroidCertificateViaAdbInput = {
  deviceSerial?: string;
};

export type SetAndroidProxyViaAdbInput = {
  deviceSerial?: string;
  host: string;
  port: number;
};

export type ClearAndroidProxyViaAdbInput = {
  deviceSerial?: string;
};

export type InstallIosCertificateViaSimulatorInput = {
  simulatorUdid?: string;
};

export type IOSSimulatorCertificateInstallResult = {
  success: boolean;
  simulatorName: string;
  simulatorUdid: string;
};

export type HarmonyHdcDevice = {
  serial: string;
  state: string;
  model?: string;
};

export type InstallHarmonyCertificateViaHdcInput = {
  deviceSerial?: string;
};

export type HarmonyHdcCertificateInstallResult = {
  success: boolean;
  deviceSerial: string;
  remotePath: string;
};

export function isCertificateStatus(value: unknown): value is CertificateStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CertificateStatus> & {
    certPath?: string | null;
    fingerprint?: string | null;
  };
  if (typeof candidate.trusted !== "boolean") return false;
  if (typeof candidate.platform !== "string") return false;
  if (!["windows", "macos", "linux"].includes(candidate.platform)) return false;
  return true;
}

export function parseCertificateStatus(value: unknown): CertificateStatus {
  if (!isCertificateStatus(value)) {
    throw coerceAppError(value);
  }
  const candidate = value as CertificateStatus & {
    certPath?: string | null;
    fingerprint?: string | null;
  };
  return {
    trusted: candidate.trusted,
    platform: candidate.platform,
    ...(candidate.certPath !== null && candidate.certPath !== undefined
      ? { certPath: candidate.certPath }
      : {}),
    ...(candidate.fingerprint !== null && candidate.fingerprint !== undefined
      ? { fingerprint: candidate.fingerprint }
      : {}),
  };
}

export function isCertificateInstallGuide(value: unknown): value is CertificateInstallGuide {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CertificateInstallGuide>;
  if (typeof candidate.success !== "boolean") return false;
  if (typeof candidate.certPath !== "string") return false;
  if (typeof candidate.platform !== "string") return false;
  if (!Array.isArray(candidate.steps)) return false;
  // Each step must have a numeric order and a string description (M14).
  return candidate.steps.every(
    (step): step is { order: number; description: string } =>
      typeof step === "object" &&
      step !== null &&
      typeof step.order === "number" &&
      typeof step.description === "string",
  );
}

export function parseCertificateInstallGuide(value: unknown): CertificateInstallGuide {
  if (!isCertificateInstallGuide(value)) {
    throw coerceAppError(value);
  }
  return value as CertificateInstallGuide;
}

export type DiagnosticCheck = {
  key: string;
  ok: boolean;
  message?: string;
};

// Structured setup diagnostic returned by the `diagnose_certificate_setup` command.
// Aggregates cert presence/trust, adb availability, hdc availability, and iOS
// Simulator tooling so the UI can render actionable guidance without re-deriving
// platform specifics.
export type SetupDiagnostic = {
  platform: string;
  certPresent: boolean;
  certPath?: string;
  certTrusted: boolean;
  adbAvailable: boolean;
  hdcAvailable: boolean;
  iosSimulatorTooling: boolean;
  checks: DiagnosticCheck[];
};

export function isSetupDiagnostic(value: unknown): value is SetupDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SetupDiagnostic>;
  if (
    typeof candidate.platform !== "string" ||
    typeof candidate.certPresent !== "boolean" ||
    typeof candidate.certTrusted !== "boolean" ||
    typeof candidate.adbAvailable !== "boolean" ||
    typeof candidate.hdcAvailable !== "boolean" ||
    typeof candidate.iosSimulatorTooling !== "boolean" ||
    !Array.isArray(candidate.checks)
  ) {
    return false;
  }
  // Each check must match the DiagnosticCheck shape (M14).
  return candidate.checks.every(
    (check): check is DiagnosticCheck =>
      typeof check === "object" &&
      check !== null &&
      typeof check.key === "string" &&
      typeof check.ok === "boolean" &&
      (check.message === undefined || typeof check.message === "string"),
  );
}

export function parseSetupDiagnostic(value: unknown): SetupDiagnostic {
  if (!isSetupDiagnostic(value)) {
    throw coerceAppError(value);
  }
  return value as SetupDiagnostic;
}

export function isAndroidAdbCertificateInstallResult(
  value: unknown,
): value is AndroidAdbCertificateInstallResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AndroidAdbCertificateInstallResult>;
  return (
    typeof candidate.success === "boolean" &&
    typeof candidate.deviceSerial === "string" &&
    typeof candidate.remotePath === "string"
  );
}

export function parseAndroidAdbCertificateInstallResult(
  value: unknown,
): AndroidAdbCertificateInstallResult {
  if (!isAndroidAdbCertificateInstallResult(value)) {
    throw coerceAppError(value);
  }
  return value;
}

export function isAndroidAdbProxyResult(value: unknown): value is AndroidAdbProxyResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AndroidAdbProxyResult>;
  return (
    typeof candidate.success === "boolean" &&
    typeof candidate.deviceSerial === "string" &&
    isNullableString(candidate.proxyAddress)
  );
}

export function parseAndroidAdbProxyResult(value: unknown): AndroidAdbProxyResult {
  if (!isAndroidAdbProxyResult(value)) {
    throw coerceAppError(value);
  }

  const candidate = value as AndroidAdbProxyResult & {
    proxyAddress?: string | null;
  };

  return {
    success: candidate.success,
    deviceSerial: candidate.deviceSerial,
    ...(candidate.proxyAddress !== null && candidate.proxyAddress !== undefined
      ? { proxyAddress: candidate.proxyAddress }
      : {}),
  };
}

export function isAndroidAdbDevice(value: unknown): value is AndroidAdbDevice {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AndroidAdbDevice>;
  return (
    typeof candidate.serial === "string" &&
    typeof candidate.state === "string" &&
    isNullableString(candidate.model) &&
    isNullableString(candidate.product) &&
    isNullableString(candidate.device) &&
    isNullableString(candidate.transportId)
  );
}

export function parseAndroidAdbDevices(value: unknown): AndroidAdbDevice[] {
  if (!Array.isArray(value) || !value.every(isAndroidAdbDevice)) {
    throw coerceAppError(value);
  }

  return value.map((device) => ({
    serial: device.serial,
    state: device.state,
    ...(device.model !== null && device.model !== undefined ? { model: device.model } : {}),
    ...(device.product !== null && device.product !== undefined ? { product: device.product } : {}),
    ...(device.device !== null && device.device !== undefined ? { device: device.device } : {}),
    ...(device.transportId !== null && device.transportId !== undefined
      ? { transportId: device.transportId }
      : {}),
  }));
}

export function isHarmonyHdcDevice(value: unknown): value is HarmonyHdcDevice {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HarmonyHdcDevice>;
  return (
    typeof candidate.serial === "string" &&
    typeof candidate.state === "string" &&
    isNullableString(candidate.model)
  );
}

export function parseHarmonyHdcDevices(value: unknown): HarmonyHdcDevice[] {
  if (!Array.isArray(value) || !value.every(isHarmonyHdcDevice)) {
    throw coerceAppError(value);
  }

  return value.map((device) => ({
    serial: device.serial,
    state: device.state,
    ...(device.model !== null && device.model !== undefined ? { model: device.model } : {}),
  }));
}

export function isHarmonyHdcCertificateInstallResult(
  value: unknown,
): value is HarmonyHdcCertificateInstallResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HarmonyHdcCertificateInstallResult>;
  return (
    typeof candidate.success === "boolean" &&
    typeof candidate.deviceSerial === "string" &&
    typeof candidate.remotePath === "string"
  );
}

export function parseHarmonyHdcCertificateInstallResult(
  value: unknown,
): HarmonyHdcCertificateInstallResult {
  if (!isHarmonyHdcCertificateInstallResult(value)) {
    throw coerceAppError(value);
  }
  return value;
}

export function isIOSSimulatorDevice(value: unknown): value is IOSSimulatorDevice {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IOSSimulatorDevice>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.udid === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.runtime === "string"
  );
}

export function parseIOSSimulatorDevices(value: unknown): IOSSimulatorDevice[] {
  if (!Array.isArray(value) || !value.every(isIOSSimulatorDevice)) {
    throw coerceAppError(value);
  }

  return value.map((device) => ({
    name: device.name,
    udid: device.udid,
    state: device.state,
    runtime: device.runtime,
  }));
}

export function isIOSSimulatorCertificateInstallResult(
  value: unknown,
): value is IOSSimulatorCertificateInstallResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IOSSimulatorCertificateInstallResult>;
  return (
    typeof candidate.success === "boolean" &&
    typeof candidate.simulatorName === "string" &&
    typeof candidate.simulatorUdid === "string"
  );
}

export function parseIOSSimulatorCertificateInstallResult(
  value: unknown,
): IOSSimulatorCertificateInstallResult {
  if (!isIOSSimulatorCertificateInstallResult(value)) {
    throw coerceAppError(value);
  }

  return value;
}

export function normalizeGenerateRootCertificateInput(
  input?: GenerateRootCertificateInput,
): GenerateRootCertificateInput {
  return {
    forceRegenerate: input?.forceRegenerate ?? false,
  };
}

// Trust-removal report returned by the `remove_certificate_trust` command.
// One entry per platform trust store the removal touched: `succeeded` covers
// both "removed" and "was never there" (removal is idempotent), while each
// `failed` entry pairs with per-store manual removal guidance in the UI —
// privilege failures are expected on several stores (Windows LocalMachine
// Root, macOS system domain / System keychain, Linux system anchor dirs).
export type TrustRemovalFailure = {
  store: string;
  error: string;
};

export type TrustRemovalReport = {
  attempted: string[];
  succeeded: string[];
  failed: TrustRemovalFailure[];
};

export type RemoveCertificateTrustOutput = {
  status: CertificateStatus;
  trustRemoval: TrustRemovalReport;
  /** Set when handing the OS proxy back failed — the machine may still be
   * routed through the (now untrusted) proxy; the UI must warn and point the
   * user at manually disabling the system proxy. */
  systemProxyHandbackError?: string;
};

export function isTrustRemovalFailure(value: unknown): value is TrustRemovalFailure {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TrustRemovalFailure>;
  return typeof candidate.store === "string" && typeof candidate.error === "string";
}

export function isTrustRemovalReport(value: unknown): value is TrustRemovalReport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TrustRemovalReport>;
  return (
    Array.isArray(candidate.attempted) &&
    candidate.attempted.every((store) => typeof store === "string") &&
    Array.isArray(candidate.succeeded) &&
    candidate.succeeded.every((store) => typeof store === "string") &&
    Array.isArray(candidate.failed) &&
    candidate.failed.every(isTrustRemovalFailure)
  );
}

export function parseRemoveCertificateTrustOutput(value: unknown): RemoveCertificateTrustOutput {
  if (
    typeof value !== "object" ||
    value === null ||
    !isCertificateStatus((value as Partial<RemoveCertificateTrustOutput>).status) ||
    !isTrustRemovalReport((value as Partial<RemoveCertificateTrustOutput>).trustRemoval) ||
    !isNullableString(
      (
        value as Partial<RemoveCertificateTrustOutput> & {
          systemProxyHandbackError?: string | null;
        }
      ).systemProxyHandbackError,
    )
  ) {
    throw coerceAppError(value);
  }
  const candidate = value as RemoveCertificateTrustOutput & {
    systemProxyHandbackError?: string | null;
  };
  return {
    status: parseCertificateStatus(candidate.status),
    trustRemoval: candidate.trustRemoval,
    ...(candidate.systemProxyHandbackError !== null &&
    candidate.systemProxyHandbackError !== undefined
      ? { systemProxyHandbackError: candidate.systemProxyHandbackError }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Breakpoint type guards
// ---------------------------------------------------------------------------
