import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SetupChecklistCard } from "./SetupChecklistCard";

// Controllable mock state shared across the component's hooks.
const state = vi.hoisted(() => ({
  nextAction: "proxyRunning" as string | null,
  shouldShowChecklist: true,
  portInUse: null as { port: number } | null,
  startProxy: { mutate: vi.fn(), isPending: false },
  requestOpenPortDialog: vi.fn(),
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    // Render the key (with :port appended when interpolated) so assertions can
    // target keys directly instead of coupled copy.
    t: (key: string, params?: Record<string, unknown>) =>
      params && params.port !== undefined ? `${key}:${String(params.port)}` : key,
    tList: (key: string) => [key],
  }),
}));

vi.mock("@/features/setup-wizard/use-setup-wizard", () => ({
  useSetupWizard: () => ({
    progress: { nextAction: state.nextAction, proxyRunning: false, steps: {} },
    shouldShowChecklist: state.shouldShowChecklist,
    acknowledgeManualProxy: vi.fn(),
  }),
}));

vi.mock("@/features/proxy-status/use-proxy-status", () => ({
  useStartProxy: () => state.startProxy,
}));

vi.mock("@/features/proxy-status/proxy-start.store", () => ({
  useProxyStartStore: (
    selector: (s: { portInUse: typeof state.portInUse; requestOpenPortDialog: () => void }) => unknown,
  ) => selector({ portInUse: state.portInUse, requestOpenPortDialog: state.requestOpenPortDialog }),
}));

vi.mock("@/features/proxy-status/use-proxy-start-defaults", () => ({
  useProxyStartDefaults: () => ({ enableSsl: true, port: 8888, workspaceId: "default" }),
}));

vi.mock("@/app/store/app-preferences.store", () => ({
  useAppPreferencesStore: (
    selector: (s: { resetSetupWizardState: () => void }) => unknown,
  ) => selector({ resetSetupWizardState: vi.fn() }),
}));

function renderCard() {
  return render(
    <MemoryRouter>
      <SetupChecklistCard />
    </MemoryRouter>,
  );
}

describe("SetupChecklistCard", () => {
  beforeEach(() => {
    state.nextAction = "proxyRunning";
    state.shouldShowChecklist = true;
    state.portInUse = null;
    state.startProxy = { mutate: vi.fn(), isPending: false };
    state.requestOpenPortDialog = vi.fn();
  });

  it("renders nothing when the checklist should not show", () => {
    state.shouldShowChecklist = false;
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows 'Start proxy' (not 'Open certificates') when the proxy step is the blocker", () => {
    state.nextAction = "proxyRunning";
    renderCard();

    expect(screen.getByText("common.actions.startProxy")).toBeInTheDocument();
    expect(screen.queryByText("setupChecklist.openCertificates")).not.toBeInTheDocument();
  });

  it("shows 'Open certificates' for non-proxy steps", () => {
    state.nextAction = "certGenerated";
    renderCard();

    expect(screen.getByText("setupChecklist.openCertificates")).toBeInTheDocument();
    expect(screen.queryByText("common.actions.startProxy")).not.toBeInTheDocument();
  });

  it("starts the proxy with the assembled defaults when 'Start proxy' is clicked", () => {
    renderCard();

    fireEvent.click(screen.getByText("common.actions.startProxy"));

    expect(state.startProxy.mutate).toHaveBeenCalledWith({
      enableSsl: true,
      port: 8888,
      workspaceId: "default",
    });
  });

  it("surfaces the port-in-use warning with a 'Change port' action on the proxy step", () => {
    state.nextAction = "proxyRunning";
    state.portInUse = { port: 8888 };
    renderCard();

    expect(screen.getByText("errorGuidance.reason.portInUse")).toBeInTheDocument();
    expect(screen.getByText("appShell.proxyPortInUse:8888")).toBeInTheDocument();
    expect(screen.getByText("setupChecklist.changePort")).toBeInTheDocument();
  });

  it("requests the port dialog when 'Change port' is clicked", () => {
    state.nextAction = "proxyRunning";
    state.portInUse = { port: 8888 };
    renderCard();

    fireEvent.click(screen.getByText("setupChecklist.changePort"));
    expect(state.requestOpenPortDialog).toHaveBeenCalledOnce();
  });

  it("does not show the port-in-use warning when the port is free", () => {
    state.nextAction = "proxyRunning";
    state.portInUse = null;
    renderCard();

    expect(screen.queryByText("errorGuidance.reason.portInUse")).not.toBeInTheDocument();
    expect(screen.queryByText("setupChecklist.changePort")).not.toBeInTheDocument();
  });
});
