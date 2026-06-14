import { describe, expect, it } from "vitest";
import {
  createDefaultProxyStatus,
  DEFAULT_PROXY_PORT,
  DEFAULT_WORKSPACE_ID,
  type CertificateStatus,
  type ProxyStatus,
} from "@aiproxy/shared-types";

import {
  computeSetupProgress,
  shouldShowSetupWizard,
  type ManualProxyAck,
} from "./setup-progress.helpers";

const certStatus = (overrides: Partial<CertificateStatus> = {}): CertificateStatus => ({
  trusted: false,
  platform: "macos",
  ...overrides,
});

const proxyStatus = (overrides: Partial<ProxyStatus> = {}): ProxyStatus => ({
  ...createDefaultProxyStatus(),
  ...overrides,
});

const ack = (overrides: Partial<ManualProxyAck> = {}): ManualProxyAck => ({
  port: DEFAULT_PROXY_PORT,
  workspaceId: DEFAULT_WORKSPACE_ID,
  acknowledgedAt: "2026-06-14T00:00:00.000Z",
  ...overrides,
});

describe("computeSetupProgress", () => {
  it("treats every step as incomplete while statuses are still loading", () => {
    const progress = computeSetupProgress(undefined, undefined, undefined);

    expect(progress).toMatchObject({
      certGenerated: false,
      certTrusted: false,
      httpsReady: false,
      proxyRunning: false,
      systemProxyOn: false,
      manualProxyStillValid: false,
      proxySatisfied: false,
      captureReady: false,
      nextAction: "certGenerated",
    });
  });

  it("flags the certificate as generated once a certPath exists, even before trust", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: false }),
      undefined,
      undefined,
    );

    expect(progress.certGenerated).toBe(true);
    expect(progress.certTrusted).toBe(false);
    expect(progress.httpsReady).toBe(false);
    expect(progress.nextAction).toBe("certTrusted");
  });

  it("reaches httpsReady when the certificate is trusted", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      undefined,
      undefined,
    );

    expect(progress.httpsReady).toBe(true);
    expect(progress.nextAction).toBe("proxyRunning");
  });

  it("is not captureReady when the proxy is not running", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      proxyStatus({ running: false }),
      undefined,
    );

    expect(progress.proxyRunning).toBe(false);
    expect(progress.captureReady).toBe(false);
    expect(progress.nextAction).toBe("proxyRunning");
  });

  it("is captureReady when the cert is trusted, proxy is running, and system proxy is on", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      proxyStatus({ running: true, systemProxyEnabled: true }),
      undefined,
    );

    expect(progress.proxySatisfied).toBe(true);
    expect(progress.captureReady).toBe(true);
    expect(progress.nextAction).toBe(null);
  });

  it("asks for the routing step when the proxy runs but system proxy is off and no manual ack", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      proxyStatus({ running: true, systemProxyEnabled: false }),
      undefined,
    );

    expect(progress.proxySatisfied).toBe(false);
    expect(progress.captureReady).toBe(false);
    expect(progress.nextAction).toBe("systemProxyOrManual");
  });

  it("treats a matching manual proxy ack as satisfying the routing step", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      proxyStatus({ running: true, systemProxyEnabled: false, port: 8888, activeWorkspaceId: "ws-1" }),
      ack({ port: 8888, workspaceId: "ws-1" }),
    );

    expect(progress.manualProxyStillValid).toBe(true);
    expect(progress.proxySatisfied).toBe(true);
    expect(progress.captureReady).toBe(true);
  });

  it("invalidates the manual ack when the proxy port changes", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      proxyStatus({ running: true, systemProxyEnabled: false, port: 9999, activeWorkspaceId: "ws-1" }),
      ack({ port: 8888, workspaceId: "ws-1" }),
    );

    expect(progress.manualProxyStillValid).toBe(false);
    expect(progress.proxySatisfied).toBe(false);
    expect(progress.captureReady).toBe(false);
  });

  it("invalidates the manual ack when the workspace changes", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      proxyStatus({ running: true, systemProxyEnabled: false, port: 8888, activeWorkspaceId: "ws-2" }),
      ack({ port: 8888, workspaceId: "ws-1" }),
    );

    expect(progress.manualProxyStillValid).toBe(false);
  });

  it("compares the manual ack workspace against the default when activeWorkspaceId is missing", () => {
    // Omit activeWorkspaceId entirely to exercise the `?? DEFAULT_WORKSPACE_ID` fallback.
    const statusWithoutWorkspace: ProxyStatus = {
      running: true,
      port: DEFAULT_PROXY_PORT,
      sslEnabled: true,
      systemProxyEnabled: false,
    };
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      statusWithoutWorkspace,
      ack({ port: DEFAULT_PROXY_PORT, workspaceId: DEFAULT_WORKSPACE_ID }),
    );

    expect(progress.manualProxyStillValid).toBe(true);
    expect(progress.captureReady).toBe(true);
  });

  it("exposes a steps map mirroring the ordered checklist", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      proxyStatus({ running: true, systemProxyEnabled: false }),
      undefined,
    );

    expect(progress.steps).toEqual({
      certGenerated: true,
      certTrusted: true,
      proxyRunning: true,
      sslDecryption: true,
      systemProxyOrManual: false,
    });
  });

  it("is not captureReady when SSL decryption is off, even if everything else is done", () => {
    const progress = computeSetupProgress(
      certStatus({ certPath: "/path/to/ca.pem", trusted: true }),
      proxyStatus({ running: true, systemProxyEnabled: true, sslEnabled: false }),
      undefined,
    );

    expect(progress.sslEnabled).toBe(false);
    expect(progress.captureReady).toBe(false);
    expect(progress.nextAction).toBe("sslDecryption");
  });
});

describe("shouldShowSetupWizard", () => {
  it("shows the wizard for a fresh user who has not reached captureReady", () => {
    expect(
      shouldShowSetupWizard({
        setupWizardCompleted: false,
        setupWizardDismissedAt: undefined,
        captureReady: false,
      }),
    ).toBe(true);
  });

  it("does not show the wizard once captureReady is reached", () => {
    expect(
      shouldShowSetupWizard({
        setupWizardCompleted: false,
        setupWizardDismissedAt: undefined,
        captureReady: true,
      }),
    ).toBe(false);
  });

  it("does not re-show the wizard after the user dismissed it", () => {
    expect(
      shouldShowSetupWizard({
        setupWizardCompleted: false,
        setupWizardDismissedAt: "2026-06-14T00:00:00.000Z",
        captureReady: false,
      }),
    ).toBe(false);
  });

  it("does not re-show the wizard after it was completed, even if captureReady regresses", () => {
    expect(
      shouldShowSetupWizard({
        setupWizardCompleted: true,
        setupWizardDismissedAt: undefined,
        captureReady: false,
      }),
    ).toBe(false);
  });
});

