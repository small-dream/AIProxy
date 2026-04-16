import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsPage } from "@/pages/settings";

import { AppProviders } from "./providers/AppProviders";

describe("AppProviders", () => {
  it("renders the settings page with English copy by default", () => {
    render(
      <AppProviders>
        <SettingsPage />
      </AppProviders>,
    );

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Language & Region")).toBeInTheDocument();
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getAllByText("Display Language")).toHaveLength(2);
    expect(screen.getAllByText("Follow System")).toHaveLength(2);
    expect(screen.getAllByText("Appearance Theme")).toHaveLength(2);
    expect(screen.getAllByText("Interface Font")).toHaveLength(2);
    expect(screen.getAllByText("Content & Code Font")).toHaveLength(2);
    expect(screen.getAllByText("Font Size")).toHaveLength(2);
  });

  it("shows the follow-system language hint", () => {
    render(
      <AppProviders>
        <SettingsPage />
      </AppProviders>,
    );

    expect(
      screen.getByText(
        "Following system language will resolve automatically from the current desktop environment.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the effective appearance summary", () => {
    render(
      <AppProviders>
        <SettingsPage />
      </AppProviders>,
    );

    expect(
      screen.getByText(
        "Current appearance: Light · UI: System Default · Content: System Monospace · 14px",
      ),
    ).toBeInTheDocument();
  });
});
