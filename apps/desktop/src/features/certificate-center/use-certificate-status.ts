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
    // DiagnosticsCard renders the failure inline with a retry action; the
    // QueryCache toast would report it twice.
    meta: { suppressGlobalErrorNotification: true },
  });
}

// `meta` flows into the mutation definition (v5 has no per-mutate meta) so a
// caller rendering its own localized failure can mark the mutation with
// `suppressGlobalErrorNotification` and opt out of the AppProviders
// MutationCache toast (P1-19/P1-27).
type MutationMetaOptions = {
  meta?: { suppressGlobalErrorNotification?: boolean } | undefined;
};

export function useGenerateRootCertificate(options?: MutationMetaOptions) {
  const queryClient = useQueryClient();

  return useMutation<CertificateStatus, Error, GenerateRootCertificateInput | undefined>({
    mutationFn: (input) => generateRootCertificate(input),
    onSuccess: (status: CertificateStatus) => {
      queryClient.setQueryData(CERTIFICATE_STATUS_QUERY_KEY, status);
    },
    ...(options?.meta ? { meta: options.meta } : {}),
  });
}

export function useOpenCertificateInstallGuide() {
  return useMutation<CertificateInstallGuide, Error, void>({
    mutationFn: () => openCertificateInstallGuide(),
  });
}

export function useLaunchCertificateInstaller(options?: MutationMetaOptions) {
  return useMutation<void, Error, void>({
    mutationFn: () => launchCertificateInstaller(),
    ...(options?.meta ? { meta: options.meta } : {}),
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
    // The page surfaces removal failures through its removeFeedback state.
    meta: { suppressGlobalErrorNotification: true },
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

// The mobile quick-action panels render install/proxy failures inline
// (`*.error.message` in the panel body), so these mutations opt out of the
// global MutationCache toast to avoid double reporting.
export function useInstallAndroidCertificateViaAdb() {
  return useMutation<
    AndroidAdbCertificateInstallResult,
    Error,
    InstallAndroidCertificateViaAdbInput | undefined
  >({
    mutationFn: (input) => installAndroidCertificateViaAdb(input),
    meta: { suppressGlobalErrorNotification: true },
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
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useSetAndroidProxyViaAdb() {
  return useMutation<AndroidAdbProxyResult, Error, SetAndroidProxyViaAdbInput>({
    mutationFn: (input) => setAndroidProxyViaAdb(input),
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function useClearAndroidProxyViaAdb() {
  return useMutation<AndroidAdbProxyResult, Error, ClearAndroidProxyViaAdbInput | undefined>({
    mutationFn: (input) => clearAndroidProxyViaAdb(input),
    meta: { suppressGlobalErrorNotification: true },
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
    meta: { suppressGlobalErrorNotification: true },
  });
}
