import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  parsePortOccupant,
  type KillPortProcessInput,
  type PortOccupant,
} from "@aiproxy/shared-types";

import { logDevInfo } from "@/services/logger/dev-logger";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

// Resolves the process currently listening on `port`, or null when the port is
// free / the occupant can't be determined (e.g. lsof missing on a minimal
// Linux image). Powers the port-change dialog's "end the process and restart
// on this port" recovery option.
export async function getPortOccupant(port: number): Promise<PortOccupant | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  try {
    logDevInfo("ui.commands", "get_port_occupant_requested", { port });
    const payload = await invoke<unknown>("get_port_occupant", { port });
    const occupant = parsePortOccupant(payload);

    logDevInfo("ui.commands", "get_port_occupant_succeeded", {
      port,
      pid: occupant?.pid ?? null,
      name: occupant?.name ?? null,
    });

    return occupant;
  } catch (error) {
    reportCommandFailure("get_port_occupant", error);
    throw coerceAppError(error);
  }
}

// Ends the process holding the proxy port so the proxy can restart on it. The
// backend re-verifies the pid (+ name) still owns the port before killing, so
// a stale occupant surfaces as a PROCESS_CHANGED error rather than a misfire.
export async function killProxyPortProcess(input: KillPortProcessInput): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  try {
    logDevInfo("ui.commands", "kill_proxy_port_process_requested", {
      port: input.port,
      pid: input.pid,
      name: input.name ?? null,
    });
    await invoke("kill_proxy_port_process", { input });

    logDevInfo("ui.commands", "kill_proxy_port_process_succeeded", { pid: input.pid });
  } catch (error) {
    reportCommandFailure("kill_proxy_port_process", error);
    throw coerceAppError(error);
  }
}
