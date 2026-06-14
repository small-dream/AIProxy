import { coerceAppError } from "@aiproxy/shared-types";

// Which wizard/action the error originated from. Drives the fallback class when
// the error code/message alone is ambiguous (e.g. a generic INTERNAL_ERROR).
export type CertificateErrorContext =
  | "generate"
  | "install"
  | "startProxy"
  | "enableSystemProxy";

// Stable classification. The wizard's page-level CertificateErrorGuidance UI maps
// each class to localized reason/steps/retry copy, keeping i18n out of this pure layer.
export type CertificateErrorClass =
  | "portInUse"
  | "certNotFound"
  | "proxyNotRunning"
  | "permissionDenied"
  | "installerFailed"
  | "generateFailed"
  | "unknown";

export type CertificateErrorGuidance = {
  errorClass: CertificateErrorClass;
  // Normalized human message from the underlying error (already coerced).
  message: string;
  // Whether retrying the same action could succeed. certNotFound in install
  // context is not retryable — the user must generate a cert first.
  canRetry: boolean;
  // Anchor into docs/user-guides/certificate-setup.md (added in P4).
  guideAnchor: string;
};

const GUIDE_ANCHORS: Record<CertificateErrorClass, string> = {
  portInUse: "#port-in-use",
  certNotFound: "#cert-not-found",
  proxyNotRunning: "#proxy-not-running",
  permissionDenied: "#permission-denied",
  installerFailed: "#installer-failed",
  generateFailed: "#generate-failed",
  unknown: "#troubleshooting",
};

function looksLikePermissionDenied(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("permission") ||
    lowerMessage.includes("denied") ||
    lowerMessage.includes("eacces") ||
    lowerMessage.includes("administrator") ||
    lowerMessage.includes("admin password")
  );
}

// Maps a thrown error (from generate/install/start-proxy/enable-system-proxy) to a
// stable, presentation-agnostic classification. Pure: no i18n, no side effects.
export function mapCertificateError(
  error: unknown,
  context: CertificateErrorContext,
): CertificateErrorGuidance {
  const normalized = coerceAppError(error);
  const message = normalized.message;
  const lowerMessage = message.toLowerCase();
  const code = normalized.code;

  let errorClass: CertificateErrorClass;

  if (code === "PORT_IN_USE" || lowerMessage.includes("already in use")) {
    errorClass = "portInUse";
  } else if (code === "CERT_NOT_FOUND") {
    errorClass = "certNotFound";
  } else if (code === "PROXY_NOT_RUNNING") {
    errorClass = "proxyNotRunning";
  } else if (looksLikePermissionDenied(lowerMessage)) {
    errorClass = "permissionDenied";
  } else if (context === "generate") {
    errorClass = "generateFailed";
  } else if (context === "install") {
    errorClass = "installerFailed";
  } else {
    errorClass = "unknown";
  }

  const canRetry = !(errorClass === "certNotFound" && context === "install");

  return {
    errorClass,
    message,
    canRetry,
    guideAnchor: GUIDE_ANCHORS[errorClass],
  };
}
