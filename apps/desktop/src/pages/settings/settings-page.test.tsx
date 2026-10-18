import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import {
  getAgentClientConnectionState,
  shouldConfirmConfigWrite,
} from "@/features/agent-access/agent-access.helpers";
import type { AgentClientInfo } from "@aiproxy/shared-types";

import { SettingsPage } from "./SettingsPage";

function renderSettings(initialEntry = "/settings") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SettingsPage />
    </MemoryRouter>,
    { wrapper: AppProviders },
  );
}

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

  it("writes the Codex MCP config through the one-click flow", async () => {
    renderSettings("/settings?section=agent");

    fireEvent.click((await screen.findAllByRole("button", { name: "Connect" }))[0]!);

    expect(screen.queryByText("Write MCP configuration?")).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        "MCP configuration written for Codex. Restart or reload Codex to activate it; the Skill is installed.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findAllByText("Configured")).toHaveLength(1);
  });

  it("connects Claude Code through the same global one-click flow", async () => {
    renderSettings("/settings?section=agent");

    const connectButtons = await screen.findAllByRole("button", { name: "Connect" });
    fireEvent.click(connectButtons[1]!);

    expect(
      await screen.findByText(
        "MCP configuration written for Claude Code. Restart or reload Claude Code to activate it; the Skill is installed.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Configured")).toHaveLength(1);
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
    await screen.findByText(
      "MCP configuration written for Codex. Restart or reload Codex to activate it; the Skill is installed.",
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions: Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(screen.getByText("Disconnect Codex?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/Disconnected Codex/)).toBeInTheDocument();
    expect(screen.getAllByText("Not configured")).toHaveLength(3);
  });

  it("keeps advanced Agent permissions collapsed until requested", async () => {
    renderSettings("/settings?section=agent");

    expect(await screen.findByText("Read permissions")).toBeInTheDocument();
    expect(screen.queryByText("Read unredacted bodies (high risk)")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Advanced permissions" }));

    expect(screen.getByText("Read unredacted bodies (high risk)")).toBeInTheDocument();
    expect(screen.getByText("Body chunk limit")).toBeInTheDocument();
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
