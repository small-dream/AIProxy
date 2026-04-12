import { useQuery } from "@tanstack/react-query";
import { getLocalIp } from "@/services/commands";

const LOCAL_IP_QUERY_KEY = ["local-ip"] as const;

export function useLocalIp() {
  return useQuery<string[]>({
    queryKey: LOCAL_IP_QUERY_KEY,
    queryFn: getLocalIp,
    staleTime: 30_000,
  });
}
