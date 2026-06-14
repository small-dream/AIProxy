import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AndroidAdbCertificateInstallResult,
  type AndroidAdbDevice,
  type AndroidAdbProxyResult,
  type CertificateInstallGuide,
  type CertificateStatus,
  type ClearAndroidProxyViaAdbInput,
  type GenerateRootCertificateInput,
  type InstallAndroidCertificateViaAdbInput,
  type InstallIosCertificateViaSimulatorInput,
  type IOSSimulatorCertificateInstallResult,
  type IOSSimulatorDevice,
  type SetAndroidProxyViaAdbInput,
  type SetupDiagnostic,
} from "@aiproxy/shared-types";
import {
  clearAndroidProxyViaAdb,
  getCertificateStatus,
  generateRootCertificate,
  installAndroidCertificateViaAdb,
  installIosCertificateViaSimulator,
  listAndroidAdbDevices,
  listIosSimulators,
  openCertificateInstallGuide,
  setAndroidProxyViaAdb,
  launchCertificateInstaller,
  diagnoseCertificateSetup,
} from "@/services/commands";

const CERTIFICATE_STATUS_QUERY_KEY = ["certificate-status"] as const;
const ANDROID_ADB_DEVICES_QUERY_KEY = ["android-adb-devices"] as const;
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

type DeviceQueryOptions = {
  enabled?: boolean;
};

export function useAndroidAdbDevices(options?: DeviceQueryOptions) {
  return useQuery<AndroidAdbDevice[]>({
    queryKey: ANDROID_ADB_DEVICES_QUERY_KEY,
    queryFn: listAndroidAdbDevices,
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
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
