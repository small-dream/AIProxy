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

    expect(screen.getByRole("heading", { level: 5, name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByText("Session Explorer")).toBeInTheDocument();
    expect(await screen.findByText(/No captured sessions yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Proxy" })).toBeInTheDocument();
  });
});
