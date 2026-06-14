import { describe, expect, it } from "vitest";

import { mapCertificateError } from "./error-guidance";

const appError = (code: string, message: string) => ({ code, message });

describe("mapCertificateError", () => {
  it("classifies a PORT_IN_USE error regardless of the action context", () => {
    const guidance = mapCertificateError(
      appError("PORT_IN_USE", "Port 8888 is already in use"),
      "startProxy",
    );

    expect(guidance.errorClass).toBe("portInUse");
    expect(guidance.canRetry).toBe(true);
    expect(guidance.guideAnchor).toBe("#port-in-use");
  });

  it("detects port-in-use from the message when the code is generic", () => {
    const guidance = mapCertificateError(
      appError("INTERNAL_ERROR", "bind: Address already in use"),
      "startProxy",
    );

    expect(guidance.errorClass).toBe("portInUse");
  });

  it("marks cert-not-found in install context as not retryable (must generate first)", () => {
    const guidance = mapCertificateError(
      appError("CERT_NOT_FOUND", "No certificate found. Generate one first."),
      "install",
    );

    expect(guidance.errorClass).toBe("certNotFound");
    expect(guidance.canRetry).toBe(false);
  });

  it("keeps cert-not-found retryable in the generate context", () => {
    const guidance = mapCertificateError(
      appError("CERT_NOT_FOUND", "No certificate found."),
      "generate",
    );

    expect(guidance.errorClass).toBe("certNotFound");
    expect(guidance.canRetry).toBe(true);
  });

  it("classifies a proxy-not-running error when enabling system proxy", () => {
    const guidance = mapCertificateError(
      appError("PROXY_NOT_RUNNING", "Proxy is not running"),
      "enableSystemProxy",
    );

    expect(guidance.errorClass).toBe("proxyNotRunning");
    expect(guidance.canRetry).toBe(true);
  });

  it("classifies permission/admin-password failures as permissionDenied", () => {
    const guidance = mapCertificateError(
      appError("INTERNAL_ERROR", "Operation not permitted: administrator password required"),
      "enableSystemProxy",
    );

    expect(guidance.errorClass).toBe("permissionDenied");
  });

  it("falls back to installerFailed for an unknown error in the install context", () => {
    const guidance = mapCertificateError(
      appError("INTERNAL_ERROR", "something broke"),
      "install",
    );

    expect(guidance.errorClass).toBe("installerFailed");
    expect(guidance.canRetry).toBe(true);
  });

  it("falls back to generateFailed for an unknown error in the generate context", () => {
    const guidance = mapCertificateError(appError("INTERNAL_ERROR", "rcgen failed"), "generate");

    expect(guidance.errorClass).toBe("generateFailed");
  });

  it("classifies an unknown proxy-context error as unknown", () => {
    const guidance = mapCertificateError(appError("INTERNAL_ERROR", "boom"), "startProxy");

    expect(guidance.errorClass).toBe("unknown");
  });

  it("preserves the normalized message and coerces raw Error instances", () => {
    const guidance = mapCertificateError(new Error("rcgen key error"), "generate");

    expect(guidance.message).toBe("rcgen key error");
  });
});
