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
