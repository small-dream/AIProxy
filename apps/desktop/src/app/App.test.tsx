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

    expect(screen.getByText("Session Explorer")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter hosts, paths, methods, or status")).toBeInTheDocument();
    expect(await screen.findByText(/No captured sessions yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Proxy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Sessions" })).toBeInTheDocument();
  });
});
