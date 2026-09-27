import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { SettingsPage } from "@/pages/settings";

import { AppProviders } from "./providers/AppProviders";

describe("AppProviders", () => {
  it("renders the settings page with English copy by default", () => {
    render(
      <AppProviders>
        <MemoryRouter initialEntries={["/settings"]}>
          <SettingsPage />
        </MemoryRouter>
      </AppProviders>,
    );

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proxy Presets" })).toHaveClass("Mui-selected");
    expect(screen.getByLabelText("Search settings")).toBeInTheDocument();
    expect(screen.getByText("Proxy Settings")).toBeInTheDocument();
    expect(screen.getByText("Proxy Port")).toBeInTheDocument();
  });
});
