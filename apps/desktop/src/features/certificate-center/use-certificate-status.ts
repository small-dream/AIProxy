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
} from "@/services/commands";

const CERTIFICATE_STATUS_QUERY_KEY = ["certificate-status"] as const;
const ANDROID_ADB_DEVICES_QUERY_KEY = ["android-adb-devices"] as const;
const IOS_SIMULATORS_QUERY_KEY = ["ios-simulators"] as const;

export function useCertificateStatus() {
  return useQuery<CertificateStatus>({
    queryKey: CERTIFICATE_STATUS_QUERY_KEY,
    queryFn: getCertificateStatus,
    staleTime: 30_000,
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

export function useAndroidAdbDevices() {
  return useQuery<AndroidAdbDevice[]>({
    queryKey: ANDROID_ADB_DEVICES_QUERY_KEY,
    queryFn: listAndroidAdbDevices,
    staleTime: 5_000,
  });
}

export function useInstallAndroidCertificateViaAdb() {
  return useMutation<AndroidAdbCertificateInstallResult, Error, InstallAndroidCertificateViaAdbInput | undefined>({
    mutationFn: (input) => installAndroidCertificateViaAdb(input),
  });
}

export function useIosSimulators() {
  return useQuery<IOSSimulatorDevice[]>({
    queryKey: IOS_SIMULATORS_QUERY_KEY,
    queryFn: listIosSimulators,
    staleTime: 5_000,
  });
}

export function useInstallIosCertificateViaSimulator() {
  return useMutation<IOSSimulatorCertificateInstallResult, Error, InstallIosCertificateViaSimulatorInput | undefined>({
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
