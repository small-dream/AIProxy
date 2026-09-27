import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

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
});
