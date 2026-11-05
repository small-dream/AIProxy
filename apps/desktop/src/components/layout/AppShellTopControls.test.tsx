import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppShellTopControls } from "./AppShellTopControls";

vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const baseProps = {
  headerActions: null,
  isProxyBusy: false,
  macosTitlebarEnabled: false,
  onStartProxy: vi.fn(),
  onStopProxy: vi.fn(),
  onMenuAction: vi.fn(),
  onSystemProxyToggle: vi.fn(),
  proxyRunning: false,
  startProxyLabel: "Start proxy",
  stopProxyLabel: "Stop proxy",
  systemProxyActionDisabled: false,
  systemProxyEnabled: false,
  systemProxyOffLabel: "Disable system proxy",
  systemProxyOnLabel: "Enable system proxy",
};

describe("AppShellTopControls", () => {
  it("renders the proxy controls by default", () => {
    render(<AppShellTopControls {...baseProps} />);

    expect(screen.getByRole("button", { name: "Start proxy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable system proxy" })).toBeInTheDocument();
  });

  it("hides the centered control row outside the sessions workspace", () => {
    render(<AppShellTopControls {...baseProps} showControls={false} />);

    expect(screen.queryByRole("button", { name: "Start proxy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable system proxy" })).not.toBeInTheDocument();
  });

  it("keeps the menu bar and window controls when the centered row is hidden", () => {
    render(<AppShellTopControls {...baseProps} showControls={false} />);

    expect(screen.getByRole("button", { name: "appShell.windowsMenu.file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.actions.close" })).toBeInTheDocument();
  });
});
