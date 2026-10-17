import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import type { AgentClientInfo } from "@aiproxy/shared-types";

import { SettingsPage } from "./SettingsPage";
import { shouldConfirmConfigWrite } from "./sections/AgentAccessSection";

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

  it("shows Cursor and other Agent client setup cards", async () => {
    renderSettings("/settings?section=agent");

    expect(await screen.findByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getAllByText("Write MCP config")).toHaveLength(3);
    expect(screen.queryByText("Copy MCP config")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByText("Manual setup (optional)")[0]!);
    expect(screen.getAllByText("Copy MCP config")).toHaveLength(1);
  });

  it("writes the Codex MCP config through the one-click flow", async () => {
    renderSettings("/settings?section=agent");

    fireEvent.click((await screen.findAllByText("Write MCP config"))[0]!);

    expect(screen.queryByText("Write MCP configuration?")).not.toBeInTheDocument();
    expect(await screen.findByText(/MCP configuration written to/)).toBeInTheDocument();
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
    expect(shouldConfirmConfigWrite({ ...base, client: "claude" })).toBe(true);
  });
});
