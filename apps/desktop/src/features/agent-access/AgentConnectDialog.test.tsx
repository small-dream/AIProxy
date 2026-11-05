import { fireEvent, render, screen } from "@testing-library/react";
import type { AgentClientInfo } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { AgentConnectDialog } from "./AgentConnectDialog";
import { permissionsForPreset } from "./agent-access.helpers";

const INFO: AgentClientInfo = {
  bundledSkillVersion: "3.1",
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
  it("offers read-only, full control, and custom presets", () => {
    const onChangePreset = vi.fn();
    render(
      <AppProviders>
        <AgentConnectDialog
          busy={false}
          clientLabel="Codex"
          currentPermissions={permissionsForPreset("readOnly")}
          info={INFO}
          onCancel={vi.fn()}
          onChangePreset={onChangePreset}
          onConfirm={vi.fn()}
          open
          preset="readOnly"
        />
      </AppProviders>,
    );

    expect(screen.getByRole("radio", { name: /^read-only analysis/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^full control/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^custom/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /^full control/i }));
    expect(onChangePreset).toHaveBeenCalledWith("fullControl");
  });

  it("makes the full-control risk explicit", () => {
    render(
      <AppProviders>
        <AgentConnectDialog
          busy={false}
          clientLabel="Codex"
          currentPermissions={permissionsForPreset("fullControl")}
          info={INFO}
          onCancel={vi.fn()}
          onChangePreset={vi.fn()}
          onConfirm={vi.fn()}
          open
          preset="fullControl"
        />
      </AppProviders>,
    );

    expect(screen.getByText(/saving still requires the high-risk confirmation/i)).toBeVisible();
    expect(screen.getByText(/permissions are global to aiproxy/i)).toBeVisible();
  });

  it("preserves partial control permissions by default on reconnect", () => {
    const currentPermissions = {
      ...permissionsForPreset("readOnly"),
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
          preset="custom"
        />
      </AppProviders>,
    );

    expect(screen.getByRole("radio", { name: /^custom/i })).toBeChecked();
    expect(screen.getByText(/control permissions/i)).toBeVisible();
  });

  it("does not claim read access when every read permission is disabled", () => {
    const readDisabled = {
      ...permissionsForPreset("readOnly"),
      readSessions: false,
      readBodies: false,
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
          preset="custom"
        />
      </AppProviders>,
    );

    expect(screen.getByText(/No read permissions/)).toBeVisible();
  });
});
