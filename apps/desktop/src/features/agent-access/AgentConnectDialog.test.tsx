import { fireEvent, render, screen } from "@testing-library/react";
import type { AgentClientInfo } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { AgentConnectDialog } from "./AgentConnectDialog";
import { permissionsForPreset } from "./agent-access.helpers";

const INFO: AgentClientInfo = {
  bundledSkillVersion: "3.0",
  client: "codex",
  configExists: false,
  configFormat: "toml",
  configInstalled: false,
  configPath: "/tmp/codex.toml",
  configSnippet: "",
  skillInstalled: false,
  skillManaged: false,
  skillPath: "/tmp/skills/aiproxy/SKILL.md",
};

describe("AgentConnectDialog", () => {
  it("offers full control and reports preset changes", () => {
    const onChangePreset = vi.fn();
    render(
      <AppProviders>
        <AgentConnectDialog
          busy={false}
          clientLabel="Codex"
          currentPermissions={permissionsForPreset("bodies")}
          info={INFO}
          onCancel={vi.fn()}
          onChangePreset={onChangePreset}
          onConfirm={vi.fn()}
          open
          preset="bodies"
        />
      </AppProviders>,
    );

    expect(screen.getByRole("radio", { name: /full control/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /full control/i }));
    expect(onChangePreset).toHaveBeenCalledWith("full");
  });

  it("warns clearly when full control is selected", () => {
    render(
      <AppProviders>
        <AgentConnectDialog
          busy={false}
          clientLabel="Codex"
          currentPermissions={permissionsForPreset("full")}
          info={INFO}
          onCancel={vi.fn()}
          onChangePreset={vi.fn()}
          onConfirm={vi.fn()}
          open
          preset="full"
        />
      </AppProviders>,
    );

    expect(screen.getByText(/Full control lets the Agent start or stop capture/i)).toBeVisible();
    expect(screen.getByText(/full control/i, { selector: "span" })).toBeVisible();
  });

  it("preserves partial control permissions by default on reconnect", () => {
    const currentPermissions = {
      ...permissionsForPreset("bodies"),
      controlCapture: true,
      deleteSessions: true,
    };
    render(
      <AppProviders>
        <AgentConnectDialog
          busy={false}
          clientLabel="Codex"
          currentPermissions={currentPermissions}
          info={INFO}
          onCancel={vi.fn()}
          onChangePreset={vi.fn()}
          onConfirm={vi.fn()}
          open
          preset="current"
        />
      </AppProviders>,
    );

    expect(screen.getByRole("radio", { name: /keep current permissions/i })).toBeChecked();
    expect(screen.getByText(/control permissions/i)).toBeVisible();
  });

  it("does not claim read access when every read permission is disabled", () => {
    const readDisabled = {
      ...permissionsForPreset("metadata"),
      readSessions: false,
    };
    render(
      <AppProviders>
        <AgentConnectDialog
          busy={false}
          clientLabel="Codex"
          currentPermissions={readDisabled}
          info={INFO}
          onCancel={vi.fn()}
          onChangePreset={vi.fn()}
          onConfirm={vi.fn()}
          open
          preset="current"
        />
      </AppProviders>,
    );

    expect(screen.getByText(/No read permissions/)).toBeVisible();
  });
});
