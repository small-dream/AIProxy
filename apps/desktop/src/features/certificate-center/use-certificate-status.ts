import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AndroidAdbCertificateInstallResult,
  type AndroidAdbDevice,
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
  type RemoveCertificateTrustOutput,
  type SetAndroidProxyViaAdbInput,
  type SetupDiagnostic,
} from "@aiproxy/shared-types";
import { PROXY_STATUS_QUERY_KEY } from "@/features/proxy-status/use-proxy-status";
import { WORKSPACES_KEY } from "@/features/workspace-manager/use-workspaces";
import { logDevError } from "@/services/logger/dev-logger";
import {
  clearAndroidProxyViaAdb,
  getCertificateStatus,
  generateRootCertificate,
  installAndroidCertificateViaAdb,
  installHarmonyCertificateViaHdc,
  installIosCertificateViaSimulator,
  listAndroidAdbDevices,
  listHarmonyHdcDevices,
  listIosSimulators,
  openCertificateInstallGuide,
  removeCertificateTrust,
  setAndroidProxyViaAdb,
  launchCertificateInstaller,
  diagnoseCertificateSetup,
} from "@/services/commands";

const CERTIFICATE_STATUS_QUERY_KEY = ["certificate-status"] as const;
const ANDROID_ADB_DEVICES_QUERY_KEY = ["android-adb-devices"] as const;
const HARMONY_HDC_DEVICES_QUERY_KEY = ["harmony-hdc-devices"] as const;
const IOS_SIMULATORS_QUERY_KEY = ["ios-simulators"] as const;
const SETUP_DIAGNOSTIC_QUERY_KEY = ["setup-diagnostic"] as const;

export function useCertificateStatus() {
  return useQuery<CertificateStatus>({
    queryKey: CERTIFICATE_STATUS_QUERY_KEY,
    queryFn: getCertificateStatus,
    staleTime: 30_000,
  });
}

// Lazy diagnostic: spawns external probes (adb, xcrun), so it does not auto-run.
// Consumers (e.g. a "Run diagnostics" action) trigger it via `enabled` or refetch.
type DiagnosticQueryOptions = {
  enabled?: boolean;
};

export function useDiagnoseCertificateSetup(options?: DiagnosticQueryOptions) {
  return useQuery<SetupDiagnostic>({
    queryKey: SETUP_DIAGNOSTIC_QUERY_KEY,
    queryFn: diagnoseCertificateSetup,
    enabled: options?.enabled ?? false,
    staleTime: 0,
  });
}

export function useGenerateRootCertificate() {
  const queryClient = useQueryClient();

  return useMutation<CertificateStatus, Error, GenerateRootCertificateInput | undefined>({
    mutationFn: (input) => generateRootCertificate(input),
    onSuccess: (status: CertificateStatus) => {
      queryClient.setQueryData(CERTIFICATE_STATUS_QUERY_KEY, status);
    },
  });
}

export function useOpenCertificateInstallGuide() {
  return useMutation<CertificateInstallGuide, Error, void>({
    mutationFn: () => openCertificateInstallGuide(),
  });
}

export function useLaunchCertificateInstaller() {
  return useMutation<void, Error, void>({
    mutationFn: () => launchCertificateInstaller(),
  });
}

// Certificate removal revokes trust, deletes the root CA files, demotes the
// workspace to HTTP-only and restarts a running proxy without SSL — all state
// the cached proxy status and workspace list reflect, so both are refreshed.
export function useRemoveCertificateTrust() {
  const queryClient = useQueryClient();

  return useMutation<RemoveCertificateTrustOutput, Error, void>({
    mutationFn: () => removeCertificateTrust(),
    onError: (error) => {
      logDevError("ui.certificate_center", "remove_certificate_trust_mutation_failed", {
        error,
      });
    },
    onSuccess: (output) => {
      queryClient.setQueryData(CERTIFICATE_STATUS_QUERY_KEY, output.status);
      queryClient.invalidateQueries({ queryKey: PROXY_STATUS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY });
    },
  });
}

type DeviceQueryOptions = {
  enabled?: boolean;
};

export function useAndroidAdbDevices(options?: DeviceQueryOptions) {
  return useQuery<AndroidAdbDevice[]>({
    queryKey: ANDROID_ADB_DEVICES_QUERY_KEY,
    queryFn: listAndroidAdbDevices,
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
    // adb may be absent; the probe fails silently and is handled in-panel
    // (AndroidQuickActionsPanel shows the error only on a manual refresh).
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useInstallAndroidCertificateViaAdb() {
  return useMutation<
    AndroidAdbCertificateInstallResult,
    Error,
    InstallAndroidCertificateViaAdbInput | undefined
  >({
    mutationFn: (input) => installAndroidCertificateViaAdb(input),
  });
}

export function useIosSimulators(options?: DeviceQueryOptions) {
  return useQuery<IOSSimulatorDevice[]>({
    queryKey: IOS_SIMULATORS_QUERY_KEY,
    queryFn: listIosSimulators,
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
    // Xcode simctl may be absent (or this isn't macOS); the probe fails
    // silently and is handled in-panel (IosQuickActionsPanel shows the error
    // only on a manual refresh).
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useInstallIosCertificateViaSimulator() {
  return useMutation<
    IOSSimulatorCertificateInstallResult,
    Error,
    InstallIosCertificateViaSimulatorInput | undefined
  >({
    mutationFn: (input) => installIosCertificateViaSimulator(input),
  });
}

export function useSetAndroidProxyViaAdb() {
  return useMutation<AndroidAdbProxyResult, Error, SetAndroidProxyViaAdbInput>({
    mutationFn: (input) => setAndroidProxyViaAdb(input),
  });
}

export function useClearAndroidProxyViaAdb() {
  return useMutation<AndroidAdbProxyResult, Error, ClearAndroidProxyViaAdbInput | undefined>({
    mutationFn: (input) => clearAndroidProxyViaAdb(input),
  });
}

export function useHarmonyHdcDevices(options?: DeviceQueryOptions) {
  return useQuery<HarmonyHdcDevice[]>({
    queryKey: HARMONY_HDC_DEVICES_QUERY_KEY,
    queryFn: listHarmonyHdcDevices,
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
    // hdc may be absent; the probe fails silently and is handled in-panel
    // (HarmonyQuickActionsPanel shows the error only on a manual refresh).
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useInstallHarmonyCertificateViaHdc() {
  return useMutation<
    HarmonyHdcCertificateInstallResult,
    Error,
    InstallHarmonyCertificateViaHdcInput | undefined
  >({
    mutationFn: (input) => installHarmonyCertificateViaHdc(input),
  });
}
