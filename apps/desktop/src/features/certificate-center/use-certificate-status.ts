import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AndroidAdbCertificateInstallResult,
  type AndroidAdbDevice,
  type CertificateInstallGuide,
  type CertificateStatus,
  type GenerateRootCertificateInput,
  type InstallAndroidCertificateViaAdbInput,
} from "@aiproxy/shared-types";
import {
  getCertificateStatus,
  generateRootCertificate,
  installAndroidCertificateViaAdb,
  listAndroidAdbDevices,
  openCertificateInstallGuide,
  launchCertificateInstaller,
} from "@/services/commands";

const CERTIFICATE_STATUS_QUERY_KEY = ["certificate-status"] as const;
const ANDROID_ADB_DEVICES_QUERY_KEY = ["android-adb-devices"] as const;

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
