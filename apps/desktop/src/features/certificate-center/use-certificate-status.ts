import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CertificateInstallGuide,
  type CertificateStatus,
  type GenerateRootCertificateInput,
} from "@pharles/shared-types";
import {
  getCertificateStatus,
  generateRootCertificate,
  openCertificateInstallGuide,
  launchCertificateInstaller,
} from "@/services/commands";

const CERTIFICATE_STATUS_QUERY_KEY = ["certificate-status"] as const;

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
