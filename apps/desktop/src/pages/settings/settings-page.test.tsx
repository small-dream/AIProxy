import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import {
  getAgentClientConnectionState,
  shouldConfirmConfigWrite,
} from "@/features/agent-access/agent-access.helpers";
import { AGENT_PERMISSION_KEYS } from "@/features/agent-access/agent-access.permissions";
import * as commands from "@/services/commands";
import type { AgentAccessPermissions, AgentClientInfo } from "@aiproxy/shared-types";

import { SettingsPage } from "./SettingsPage";

function renderSettings(initialEntry = "/settings") {
  const router = createMemoryRouter([{ path: "/settings", element: <SettingsPage /> }], {
    initialEntries: [initialEntry],
  });
  return { ...render(<RouterProvider router={router} />, { wrapper: AppProviders }), router };
}

function permissionsWith(keys: readonly (keyof AgentAccessPermissions)[] = []) {
  const permissions = Object.fromEntries(
    AGENT_PERMISSION_KEYS.map((key) => [key, keys.includes(key)]),
  ) as AgentAccessPermissions;
  return permissions;
}

async function chooseCapabilityMode(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: `${label} permission policy` }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

async function choosePermissionPreset(option: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Permission preset" }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsPage navigation", () => {
  it("shows the proxy section by default", () => {
    renderSettings();

    expect(screen.getByText("Proxy Settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proxy Presets" })).toHaveClass("Mui-selected");
  });

  it("opens a section from the directory", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Appearance & Language" }));

    expect(screen.getByLabelText("Display Language")).toBeInTheDocument();
  });

  it("searches localized labels and jumps to the matching section item", () => {
    renderSettings("/settings?section=appearance");

    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "dark" },
    });

    const results = screen.getAllByText("Appearance Theme");
    const result = results.at(-1);
    expect(result).toBeDefined();

    if (result) {
      fireEvent.click(result);
    }
    expect(screen.getByLabelText("Appearance Theme")).toBeInTheDocument();
  });

  it("finds the Agent redaction policy from settings search", async () => {
    renderSettings();

    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "JWT" },
    });

    fireEvent.click(screen.getByText("Data redaction"));

    expect(await screen.findByText("Read permissions")).toBeInTheDocument();
    expect(
      await screen.findByRole("switch", { name: "Detect sensitive values by format" }),
    ).toBeInTheDocument();
  });

  it("finds and jumps to an Agent control permission from settings search", async () => {
    renderSettings();

    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "system proxy" },
    });

    const results = screen.getAllByText("Control the system proxy");
    fireEvent.click(results.at(-1)!);

    expect(
      await screen.findByRole("combobox", {
        name: "Control the system proxy permission policy",
      }),
    ).toBeInTheDocument();
    expect(document.getElementById("settings-item-agent-control-system-proxy")).toBeInTheDocument();
  });

  it("does not block an in-page Agent search when the draft has changes", async () => {
    renderSettings("/settings?section=agent");

    fireEvent.click(await screen.findByRole("switch", { name: "Enable local Agent access" }));
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "system proxy" },
    });
    fireEvent.click(screen.getAllByText("Control the system proxy").at(-1)!);

    expect(
      await screen.findByRole("combobox", {
        name: "Control the system proxy permission policy",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Discard unsaved Agent Access changes?")).not.toBeInTheDocument();
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("keeps reserved Agent permissions out of settings search", () => {
    renderSettings();

    const search = screen.getByLabelText("Search settings");
    fireEvent.change(search, { target: { value: "scripts" } });
    expect(screen.getByText("No matching settings")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "global automation" } });
    expect(screen.getByText("No matching settings")).toBeInTheDocument();
  });

  it("shows a compact Agent client list with manual setup in the overflow menu", async () => {
    renderSettings("/settings?section=agent");

    expect(await screen.findByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getAllByText("Not configured")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(3);
    expect(screen.queryByText("Per project")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect project" })).not.toBeInTheDocument();
    expect(screen.queryByText("Copy MCP config")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More actions: Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Manual setup" }));
    expect(screen.getAllByText("Copy MCP config")).toHaveLength(1);
  });

  it("preserves the default grant policies through the connect flow", async () => {
    renderSettings("/settings?section=agent");

    fireEvent.click((await screen.findAllByRole("button", { name: "Connect" }))[0]!);

    expect(await screen.findByText("Connect Codex")).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByRole("radio", {
        name: /^Custom/,
      }),
    ).toBeChecked();
    expect(screen.queryByText("Write MCP configuration?")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect and write" }));
    expect(
      await screen.findByText(
        "MCP configuration written for Codex. Restart or reload Codex to activate it; the Skill is installed.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Body reading is off/)).not.toBeInTheDocument();
    expect(await screen.findAllByText("Configured")).toHaveLength(1);
  });

  it("confirms high-risk permissions before connecting a client", async () => {
    renderSettings("/settings?section=agent");

    fireEvent.click((await screen.findAllByRole("button", { name: "Connect" }))[0]!);
    fireEvent.click(await screen.findByRole("radio", { name: /^Full control/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect and write" }));

    expect(
      screen.getByText("Enable high-risk Agent permissions before connecting?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect and enable" }));

    expect(await screen.findAllByText("Configured")).toHaveLength(1);
  });

  it("connects Claude Code through the same global one-click flow", async () => {
    renderSettings("/settings?section=agent");

    const connectButtons = await screen.findAllByRole("button", { name: "Connect" });
    fireEvent.click(connectButtons[1]!);
    fireEvent.click(await screen.findByRole("button", { name: "Connect and write" }));

    expect(
      await screen.findByText(
        "MCP configuration written for Claude Code. Restart or reload Claude Code to activate it; the Skill is installed.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Configured")).toHaveLength(1);
  });

  it("applies a permission preset when connecting and clears the body warning", async () => {
    const saved = await commands.getAgentAccessSettings();
    vi.spyOn(commands, "getAgentAccessSettings").mockResolvedValue({
      ...saved,
      permissions: permissionsWith(["readSessions"]),
    });
    renderSettings("/settings?section=agent");

    fireEvent.click((await screen.findAllByRole("button", { name: "Connect" }))[0]!);
    expect(
      within(await screen.findByRole("dialog")).getByRole("radio", { name: /^Custom/i }),
    ).toBeChecked();
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("radio", {
        name: /^Read-only analysis/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect and write" }));

    await screen.findByText(
      "MCP configuration written for Codex. Restart or reload Codex to activate it; the Skill is installed.",
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View permission groups" }));
    expect(
      screen.getByRole("combobox", { name: "Read bodies permission policy" }),
    ).toHaveTextContent("Always allow");
    expect(screen.queryByText(/Body reading is off/)).not.toBeInTheDocument();
  });

  it("verifies the connection and lists per-check results", async () => {
    renderSettings("/settings?section=agent");

    fireEvent.click(await screen.findByText("Diagnostics"));
    fireEvent.click(screen.getByRole("button", { name: "Verify connection" }));

    expect(await screen.findByText("Some checks failed")).toBeInTheDocument();
    expect(screen.getAllByText("MCP sidecar").length).toBeGreaterThan(0);
    expect(screen.getByText("MCP diagnostics require the desktop runtime.")).toBeInTheDocument();
  });

  it("disconnects a configured client through the overflow menu", async () => {
    renderSettings("/settings?section=agent");

    fireEvent.click((await screen.findAllByRole("button", { name: "Connect" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Connect and write" }));
    await screen.findByText(
      "MCP configuration written for Codex. Restart or reload Codex to activate it; the Skill is installed.",
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "More actions: Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(screen.getByText("Disconnect Codex?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/Disconnected Codex/)).toBeInTheDocument();
    expect(screen.getAllByText("Not configured")).toHaveLength(3);
  });

  it("keeps the Agent permission matrix and advanced settings collapsed until requested", async () => {
    renderSettings("/settings?section=agent");

    expect(await screen.findByText("Current Agent capabilities")).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", {
        name: "Control the system proxy permission policy",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View permission groups" }));

    expect(screen.getByText("Read data")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Control the system proxy permission policy" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Manage scripts")).not.toBeInTheDocument();
    expect(screen.queryByText("Map to other hosts")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage global automation")).not.toBeInTheDocument();
    expect(screen.queryByText("Read unredacted bodies (high risk)")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Advanced permissions" }));

    expect(screen.getByText("Read unredacted bodies (high risk)")).toBeInTheDocument();
    expect(screen.getByText("Body chunk limit")).toBeInTheDocument();
  });

  it("shows the current permission preset in a select and only updates the draft", async () => {
    const saved = await commands.getAgentAccessSettings();
    vi.spyOn(commands, "getAgentAccessSettings").mockResolvedValue({
      ...saved,
      permissions: permissionsWith(["readSessions", "readBodies"]),
    });
    const updateSpy = vi.spyOn(commands, "updateAgentAccessSettings");
    renderSettings("/settings?section=agent");

    const presetSelect = await screen.findByRole("combobox", { name: "Permission preset" });
    expect(presetSelect).toHaveTextContent("Read-only analysis (default)");

    await choosePermissionPreset("Full control");

    expect(presetSelect).toHaveTextContent("Full control");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("offers three presets and copies read-only analysis when Custom is selected first", async () => {
    renderSettings("/settings?section=agent");

    const presetSelect = await screen.findByRole("combobox", { name: "Permission preset" });
    expect(presetSelect).toHaveTextContent("Read-only analysis (default)");
    fireEvent.mouseDown(presetSelect);

    expect(
      await screen.findByRole("option", { name: "Read-only analysis (default)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Full control" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Custom" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Custom" }));

    expect(presetSelect).toHaveTextContent("Custom");
    fireEvent.click(screen.getByRole("button", { name: "View permission groups" }));
    expect(
      screen.getByRole("combobox", { name: "Read bodies permission policy" }),
    ).toHaveTextContent("Always allow");
    expect(
      screen.getByRole("combobox", { name: "Control the system proxy permission policy" }),
    ).toHaveTextContent("Blocked");
  });

  it("switches to Custom after a manual permission change", async () => {
    const saved = await commands.getAgentAccessSettings();
    vi.spyOn(commands, "getAgentAccessSettings").mockResolvedValue({
      ...saved,
      permissions: permissionsWith(["readSessions", "readBodies"]),
    });
    renderSettings("/settings?section=agent");

    const presetSelect = await screen.findByRole("combobox", { name: "Permission preset" });
    expect(presetSelect).toHaveTextContent("Read-only analysis (default)");
    fireEvent.click(screen.getByRole("button", { name: "View permission groups" }));
    await chooseCapabilityMode("Read WebSocket messages", "Always allow");

    expect(presetSelect).toHaveTextContent("Custom");
  });

  it("restores the previous custom permissions and policies after selecting another preset", async () => {
    const saved = await commands.getAgentAccessSettings();
    vi.spyOn(commands, "getAgentAccessSettings").mockResolvedValue({
      ...saved,
      permissions: permissionsWith(["readSessions", "readWebSocket"]),
      grantRequestPolicy: {
        ...saved.grantRequestPolicy,
        deleteSessions: "deny",
      },
    });
    renderSettings("/settings?section=agent");

    const presetSelect = await screen.findByRole("combobox", { name: "Permission preset" });
    expect(presetSelect).toHaveTextContent("Custom");

    await choosePermissionPreset("Read-only analysis (default)");
    fireEvent.click(screen.getByRole("button", { name: "View permission groups" }));
    expect(
      screen.getByRole("combobox", { name: "Read WebSocket messages permission policy" }),
    ).toHaveTextContent("Blocked");

    await choosePermissionPreset("Custom");

    expect(presetSelect).toHaveTextContent("Custom");
    expect(
      screen.getByRole("combobox", { name: "Read WebSocket messages permission policy" }),
    ).toHaveTextContent("Always allow");
    expect(
      screen.getByRole("combobox", { name: "Delete sessions permission policy" }),
    ).toHaveTextContent("Blocked");
  });

  it("batch-enables only available capabilities and keeps the high-risk save gate", async () => {
    const updateSpy = vi.spyOn(commands, "updateAgentAccessSettings");
    renderSettings("/settings?section=agent");

    fireEvent.click(await screen.findByRole("button", { name: "Batch grant..." }));
    const confirm = screen.getByRole("dialog");
    expect(within(confirm).getByText("Enable all available capabilities?")).toBeInTheDocument();
    expect(within(confirm).queryByText(/Manage scripts/)).not.toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Enable all available" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Read bodies permission policy" }),
    ).toHaveTextContent("Always allow");
    fireEvent.click(await screen.findByRole("button", { name: /Advanced permissions/ }));
    expect(
      screen.getByRole("combobox", {
        name: "Read unredacted bodies (high risk) permission policy",
      }),
    ).toHaveTextContent("Always allow");
    expect(updateSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Save changes" }).at(-1)!);
    expect(screen.getByText("Enable high-risk Agent permissions?")).toBeInTheDocument();
  });

  it("keeps the capability summary on saved settings while the draft changes", async () => {
    const saved = await commands.getAgentAccessSettings();
    vi.spyOn(commands, "getAgentAccessSettings").mockResolvedValue({
      ...saved,
      enabled: true,
      permissions: permissionsWith(["readSessions"]),
    });
    renderSettings("/settings?section=agent");

    expect(await screen.findByText("Current Agent capabilities")).toBeInTheDocument();
    expect(screen.getByText("No control or automation capabilities")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View permission groups" }));
    await chooseCapabilityMode("Control the system proxy", "Always allow");

    expect(
      screen.getByText("This summary reflects saved settings. Unsaved changes are not active."),
    ).toBeInTheDocument();
    expect(screen.getByText("No control or automation capabilities")).toBeInTheDocument();
  });

  it("shows resource boundaries only for the permissions they belong to", async () => {
    renderSettings("/settings?section=agent");

    await screen.findByText("Current Agent capabilities");
    fireEvent.click(screen.getByRole("button", { name: "View permission groups" }));

    expect(screen.queryByText("Approved Map Local roots")).not.toBeInTheDocument();
    expect(screen.queryByText("Proxy verification origins")).not.toBeInTheDocument();

    await chooseCapabilityMode("Manage Agent automation", "Always allow");

    expect(screen.getByText("Approved Map Local roots")).toBeInTheDocument();
    expect(screen.queryByText("Proxy verification origins")).not.toBeInTheDocument();

    await chooseCapabilityMode("Verify through AIProxy", "Always allow");

    expect(screen.getByText("Proxy verification origins")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Proxy verification also requires Manage Agent automation, because it verifies an automation change. Enable both capabilities before using proxy verification.",
      ),
    ).not.toBeInTheDocument();

    await chooseCapabilityMode("Manage Agent automation", "Blocked");

    expect(
      screen.getByText(
        "Proxy verification also requires Manage Agent automation, because it verifies an automation change. Enable both capabilities before using proxy verification.",
      ),
    ).toBeInTheDocument();
  });

  it("shows field-level pending changes and confirms high-risk permissions on save", async () => {
    const saved = await commands.getAgentAccessSettings();
    vi.spyOn(commands, "getAgentAccessSettings").mockResolvedValue({
      ...saved,
      permissions: permissionsWith(["readSessions", "readBodies"]),
      grantRequestPolicy: {
        ...saved.grantRequestPolicy,
        controlCapture: "ask",
      },
    });
    renderSettings("/settings?section=agent");

    await screen.findByText("Current Agent capabilities");
    fireEvent.click(screen.getByRole("button", { name: "View permission groups" }));
    await chooseCapabilityMode("Control capture and workspace settings", "Always allow");
    fireEvent.click(screen.getAllByRole("button", { name: "Review changes" })[0]!);

    expect(screen.getByText("Pending Agent Access changes")).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByText(
        (_, element) =>
          element?.tagName === "SPAN" &&
          element.textContent === "Ask when requested → Always allow",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByText("Pending Agent Access changes")).not.toBeInTheDocument(),
    );

    await chooseCapabilityMode("Replay captured requests", "Always allow");
    fireEvent.click(screen.getAllByRole("button", { name: "Save changes" }).at(-1)!);

    expect(screen.getByText("Enable high-risk Agent permissions?")).toBeInTheDocument();
    expect(screen.getByText(/This save enables: Replay captured requests/)).toBeInTheDocument();
  });

  it("closes the high-risk save confirmation and surfaces a save failure", async () => {
    vi.spyOn(commands, "updateAgentAccessSettings").mockRejectedValueOnce(
      new Error("Agent settings could not be saved"),
    );
    renderSettings("/settings?section=agent");

    await screen.findByText("Current Agent capabilities");
    fireEvent.click(screen.getByRole("button", { name: "View permission groups" }));
    await chooseCapabilityMode("Control the system proxy", "Always allow");
    fireEvent.click(screen.getAllByRole("button", { name: "Save changes" }).at(-1)!);
    expect(screen.getByText("Enable high-risk Agent permissions?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));

    await waitFor(() =>
      expect(screen.queryByText("Enable high-risk Agent permissions?")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Agent settings could not be saved")).toBeInTheDocument();
  });

  it("keeps the permission card scroll container compatible with the sticky save bar", async () => {
    renderSettings("/settings?section=agent");

    await screen.findByText("Read permissions");
    const card = screen.getByText("Read permissions").closest(".MuiCard-root");

    expect(card).not.toBeNull();
    expect(getComputedStyle(card as Element).overflow).toBe("visible");
  });

  it("does not claim current capabilities while Agent access is off", async () => {
    const saved = await commands.getAgentAccessSettings();
    vi.spyOn(commands, "getAgentAccessSettings").mockResolvedValue({
      ...saved,
      enabled: false,
      permissions: permissionsWith(["readSessions"]),
    });
    renderSettings("/settings?section=agent");

    expect(
      await screen.findByText(
        "Local Agent access is off, so the Agent cannot read or control traffic.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Can read")).not.toBeInTheDocument();
    expect(screen.queryByText("Can control")).not.toBeInTheDocument();
  });

  it("makes draft changes explicit and supports discarding them", async () => {
    renderSettings("/settings?section=agent");

    const enabledSwitch = await screen.findByRole("switch", {
      name: "Enable local Agent access",
    });
    fireEvent.click(enabledSwitch);

    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(screen.getAllByText(/You have unsaved changes/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[0]!);

    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
    expect(enabledSwitch).not.toBeChecked();
  });

  it("intercepts navigation while Agent Access has unsaved changes", async () => {
    const { router } = renderSettings("/settings?section=agent");

    const enabledSwitch = await screen.findByRole("switch", {
      name: "Enable local Agent access",
    });
    fireEvent.click(enabledSwitch);
    act(() => void router.navigate("/settings?section=appearance"));

    expect(await screen.findByText("Discard unsaved Agent Access changes?")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?section=agent");
  });

  it("leaves the section and discards the draft after confirming", async () => {
    const { router } = renderSettings("/settings?section=agent");

    fireEvent.click(await screen.findByRole("switch", { name: "Enable local Agent access" }));
    act(() => void router.navigate("/settings?section=appearance"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));

    expect(await screen.findByLabelText("Display Language")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Agent Access" }));

    expect(
      await screen.findByRole("switch", { name: "Enable local Agent access" }),
    ).not.toBeChecked();
  });

  it("keeps the Agent audit log collapsed by default", async () => {
    renderSettings("/settings?section=agent");

    expect(await screen.findByText("No Agent calls recorded yet")).toBeInTheDocument();
    expect(screen.queryByText("Duration")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View log" }));

    const hideLogButton = await screen.findByRole("button", { name: "Hide log" });
    expect(hideLogButton).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByText("No Agent tool calls have been recorded yet."),
    ).toBeInTheDocument();
  });

  it("only asks for confirmation when an existing config would be replaced", () => {
    const base: AgentClientInfo = {
      client: "codex",
      configPath: "~/.codex/config.toml",
      configExists: false,
      configInstalled: false,
      skillPath: "~/.codex/skills/aiproxy/SKILL.md",
      skillInstalled: false,
      skillManaged: false,
      skillVersion: null,
      bundledSkillVersion: "2.2",
      configFormat: "toml",
      configSnippet: "",
    };

    expect(shouldConfirmConfigWrite(base)).toBe(false);
    expect(shouldConfirmConfigWrite({ ...base, configExists: true })).toBe(true);
    expect(shouldConfirmConfigWrite({ ...base, client: "claude" })).toBe(false);
  });

  it("uses one consistent connection state per Agent client", () => {
    const base: AgentClientInfo = {
      client: "codex",
      configPath: "~/.codex/config.toml",
      configExists: false,
      configInstalled: false,
      skillPath: "~/.codex/skills/aiproxy/SKILL.md",
      skillInstalled: false,
      skillManaged: false,
      skillVersion: null,
      bundledSkillVersion: "2.2",
      configFormat: "toml",
      configSnippet: "",
    };

    expect(getAgentClientConnectionState(base)).toBe("notConnected");
    expect(getAgentClientConnectionState({ ...base, configExists: true })).toBe("notConnected");
    expect(getAgentClientConnectionState({ ...base, configInstalled: true })).toBe("needsUpdate");
    expect(getAgentClientConnectionState({ ...base, skillInstalled: true })).toBe("needsUpdate");
    expect(
      getAgentClientConnectionState({
        ...base,
        configInstalled: true,
        skillInstalled: true,
      }),
    ).toBe("connected");
    expect(getAgentClientConnectionState({ ...base, client: "claude" })).toBe("notConnected");
    expect(
      getAgentClientConnectionState({
        ...base,
        client: "claude",
        configInstalled: true,
        skillInstalled: true,
      }),
    ).toBe("connected");
  });
});
