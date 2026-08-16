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
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("Display Language")).toBeInTheDocument();
    expect(screen.getAllByText("Follow System")).toHaveLength(2);
    expect(screen.getByText("Appearance Theme")).toBeInTheDocument();
    expect(screen.getByText("Interface Font")).toBeInTheDocument();
    expect(screen.getByText("Content & Code Font")).toBeInTheDocument();
    expect(screen.getByText("Font Size")).toBeInTheDocument();
  });
});
