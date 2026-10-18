import { render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "@aiproxy/shared-types";

import { AppProviders } from "@/app/providers/AppProviders";
import { useAppPreferencesStore } from "@/app/store/app-preferences.store";

import { SslProxyingSection } from "./SslProxyingSection";

// The section reads the active workspace from the proxy status and the stored
// policy from the workspace list, so both hooks have to be driven by the test.
const state = vi.hoisted(() => ({
  workspace: null as Workspace | null,
}));

vi.mock("@/features/workspace-manager/use-workspaces", () => ({
  useWorkspaces: () => ({ data: state.workspace ? [state.workspace] : [], isError: false }),
  useUpdateWorkspace: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/features/proxy-status/use-proxy-status", () => ({
  useProxyStatus: () => ({ data: { running: false, activeWorkspaceId: "default" } }),
  useStartProxy: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/services/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/commands")>();

  return {
    ...actual,
    loadDefaultSslProxyingExclusions: vi.fn(async () => ["*.icloud.com"]),
  };
});

function buildWorkspace({
  includeEnabled,
  excludeEnabled = true,
}: {
  includeEnabled: boolean;
  excludeEnabled?: boolean;
}): Workspace {
  return {
    id: "default",
    name: "Default",
    storagePath: "/tmp/aiproxy-default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    proxyPort: 8888,
    sslEnabled: true,
    systemProxyEnabled: false,
    sslProxying: {
      includeEnabled,
      excludeEnabled,
      include: [{ pattern: "*.planetart.com", enabled: true }],
      exclude: [{ pattern: "*.icloud.com", enabled: true }],
    },
  };
}

function getBlock(itemId: string) {
  const block = document.querySelector(`[data-settings-item="${itemId}"]`);
  expect(block).not.toBeNull();
  return within(block as HTMLElement);
}

beforeEach(() => {
  useAppPreferencesStore.setState({ languagePreference: "en" });
});

describe("SslProxyingSection", () => {
  it("disables the entry switches while the Include master switch is off", () => {
    state.workspace = buildWorkspace({ includeEnabled: false });

    render(<SslProxyingSection />, { wrapper: AppProviders });

    const include = getBlock("ssl-include");
    expect(include.getByLabelText("Disable *.planetart.com")).toBeDisabled();
    expect(include.getByText(/kept but have no effect/i)).toBeInTheDocument();
  });

  it("keeps the entry switches interactive once the master switch is on", () => {
    state.workspace = buildWorkspace({ includeEnabled: true });

    render(<SslProxyingSection />, { wrapper: AppProviders });

    const include = getBlock("ssl-include");
    expect(include.getByLabelText("Disable *.planetart.com")).toBeEnabled();
    expect(include.queryByText(/kept but have no effect/i)).not.toBeInTheDocument();
  });

  it("applies the same inactive treatment to the Exclude list", () => {
    state.workspace = buildWorkspace({ includeEnabled: false, excludeEnabled: false });

    render(<SslProxyingSection />, { wrapper: AppProviders });

    const exclude = getBlock("ssl-exclude");
    expect(exclude.getByLabelText("Disable *.icloud.com")).toBeDisabled();
    expect(exclude.getByText(/kept but have no effect/i)).toBeInTheDocument();
  });
});
