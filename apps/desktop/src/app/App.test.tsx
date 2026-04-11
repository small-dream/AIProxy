import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the application shell heading", () => {
    render(<App />);

    expect(screen.getByText("Pharles")).toBeInTheDocument();
  });

  it("renders the bootstrap sessions workspace", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { level: 4, name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Proxy Runtime")).toBeInTheDocument();
    expect(await screen.findByText(/Configure your browser or system HTTP proxy/)).toBeInTheDocument();
  });
});
