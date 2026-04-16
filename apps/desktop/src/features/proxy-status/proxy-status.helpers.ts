import type { ProxyStatus } from "@aiproxy/shared-types";

type ProxyStatusPresentation = {
  chipColor: "default" | "error" | "success" | "warning";
  label: string;
};

export function getProxyStatusPresentation(status: ProxyStatus | undefined): ProxyStatusPresentation {
  if (!status) {
    return {
      chipColor: "default",
      label: "Proxy Loading",
    };
  }

  if (status.running) {
    return {
      chipColor: "success",
      label: `Proxy Running :${status.port}`,
    };
  }

  if (status.sslEnabled) {
    return {
      chipColor: "warning",
      label: `Proxy Ready :${status.port}`,
    };
  }

  return {
    chipColor: "default",
    label: `Proxy Idle :${status.port}`,
  };
}

