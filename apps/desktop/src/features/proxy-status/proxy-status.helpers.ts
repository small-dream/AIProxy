import type { ProxyStatus } from "@aiproxy/shared-types";

import { enMessages } from "@/i18n/messages/en";

type ProxyStatusPresentation = {
  chipColor: "default" | "error" | "success" | "warning";
  label: string;
};

export function getProxyStatusPresentation(status: ProxyStatus | undefined): ProxyStatusPresentation {
  if (!status) {
    return {
      chipColor: "default",
      label: enMessages.proxyStatus.loading,
    };
  }

  if (status.running) {
    return {
      chipColor: "success",
      label: enMessages.proxyStatus.runningWithPort.replace("{{port}}", String(status.port)),
    };
  }

  if (status.sslEnabled) {
    return {
      chipColor: "warning",
      label: enMessages.proxyStatus.readyWithPort.replace("{{port}}", String(status.port)),
    };
  }

  return {
    chipColor: "default",
    label: enMessages.proxyStatus.idleWithPort.replace("{{port}}", String(status.port)),
  };
}
