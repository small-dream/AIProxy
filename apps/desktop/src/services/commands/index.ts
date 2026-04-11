import { invoke } from "@tauri-apps/api/core";
import type { ProxyStatus } from "@pharles/shared-types";

export async function getBootstrapStatus(): Promise<ProxyStatus> {
  return invoke<ProxyStatus>("get_bootstrap_status");
}

