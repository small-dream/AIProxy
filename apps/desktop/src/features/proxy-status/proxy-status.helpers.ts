import type { ProxyStatus } from "@aiproxy/shared-types";

import { enMessages } from "@/i18n/messages/en";

type ProxyStatusPresentation = {
  chipColor: "default" | "error" | "success" | "warning";
  label: string;
};

export function getProxyStatusPresentation(
  status: ProxyStatus | undefined,
  messages: typeof enMessages.proxyStatus = enMessages.proxyStatus,
): ProxyStatusPresentation {
  if (!status) {
    return {
      chipColor: "default",
      label: messages.loading,
    };
  }

  if (status.running) {
    return {
      chipColor: "success",
      label: messages.runningWithPort.replaceAll("{{port}}", String(status.port)),
    };
  }

  if (status.sslEnabled) {
    return {
      chipColor: "warning",
      label: messages.readyWithPort.replaceAll("{{port}}", String(status.port)),
    };
  }

  return {
    chipColor: "default",
    label: messages.idleWithPort.replaceAll("{{port}}", String(status.port)),
  };
}

// Format elapsed recording time for the top-controls indicator: mm:ss under
// an hour, h:mm:ss beyond that. Negative or non-finite input clamps to 0:00.
export function formatRecordingDuration(elapsedMs: number): string {
  const totalSeconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}
