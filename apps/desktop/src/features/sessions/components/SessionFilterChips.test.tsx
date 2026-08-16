import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionFilterChips } from "./SessionFilterChips";

// Key-verbatim i18n mock; appends the `host` param so per-chip delete icons
// are distinguishable by their aria-label.
vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      typeof params?.host === "string" ? `${key}:${params.host}` : key,
    tList: (key: string) => [key],
    locale: "en-US",
  }),
}));

function renderChips(overrides: Partial<Parameters<typeof SessionFilterChips>[0]> = {}) {
  const props = {
    focusedHosts: new Set<string>(),
    ignoredHosts: new Set<string>(),
    showOnlyThrottled: false,
    onUnfocusHost: vi.fn(),
    onStopIgnoringHost: vi.fn(),
    onDisableThrottledOnly: vi.fn(),
    ...overrides,
  };
  const utils = render(<SessionFilterChips {...props} />);
  return { ...utils, props };
}

describe("SessionFilterChips (P0-3)", () => {
  it("renders nothing when no filter is active", () => {
    const { container } = renderChips();

    expect(container.firstChild).toBeNull();
  });

  it("shows one chip per focused/ignored host plus a throttled chip", () => {
    renderChips({
      focusedHosts: new Set(["api.example.com"]),
      ignoredHosts: new Set(["ads.example.com", "telemetry.example.com"]),
      showOnlyThrottled: true,
    });

    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(screen.getByText("ads.example.com")).toBeInTheDocument();
    expect(screen.getByText("telemetry.example.com")).toBeInTheDocument();
    expect(screen.getByText("sessionsPage.filterThrottled")).toBeInTheDocument();
  });

  it("removing an ignored host calls onStopIgnoringHost with that host", () => {
    const { props } = renderChips({
      ignoredHosts: new Set(["ads.example.com"]),
    });

    fireEvent.click(screen.getByLabelText("sessionExplorer.stopIgnoringHost:ads.example.com"));

    expect(props.onStopIgnoringHost).toHaveBeenCalledWith("ads.example.com");
    expect(props.onUnfocusHost).not.toHaveBeenCalled();
  });

  it("removing a focused host calls onUnfocusHost with that host", () => {
    const { props } = renderChips({
      focusedHosts: new Set(["api.example.com"]),
    });

    fireEvent.click(screen.getByLabelText("sessionExplorer.unfocusHost:api.example.com"));

    expect(props.onUnfocusHost).toHaveBeenCalledWith("api.example.com");
  });

  it("removing the throttled chip disables the throttled-only filter", () => {
    const { props } = renderChips({
      showOnlyThrottled: true,
    });

    fireEvent.click(screen.getByLabelText("sessionExplorer.showAllSessions"));

    expect(props.onDisableThrottledOnly).toHaveBeenCalledTimes(1);
  });

  it("collapses more than 3 ignored hosts into one summary chip with a popover", () => {
    const { props } = renderChips({
      ignoredHosts: new Set(["a.example.com", "b.example.com", "c.example.com", "d.example.com"]),
    });

    expect(screen.queryByText("a.example.com")).not.toBeInTheDocument();
    expect(screen.getByText("sessionExplorer.ignoredHostsSummary")).toBeInTheDocument();

    fireEvent.click(screen.getByText("sessionExplorer.ignoredHostsSummary"));

    expect(screen.getByText("b.example.com")).toBeInTheDocument();
    expect(screen.getByText("sessionExplorer.clearAllIgnoredHosts")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("sessionExplorer.stopIgnoringHost:b.example.com"));
    expect(props.onStopIgnoringHost).toHaveBeenCalledWith("b.example.com");
    expect(props.onStopIgnoringHost).toHaveBeenCalledTimes(1);
  });

  it("clear-all in the ignored popover removes every ignored host", () => {
    const { props } = renderChips({
      ignoredHosts: new Set(["a.example.com", "b.example.com", "c.example.com", "d.example.com"]),
    });

    fireEvent.click(screen.getByText("sessionExplorer.ignoredHostsSummary"));
    fireEvent.click(screen.getByText("sessionExplorer.clearAllIgnoredHosts"));

    expect(props.onStopIgnoringHost).toHaveBeenCalledTimes(4);
    for (const host of ["a.example.com", "b.example.com", "c.example.com", "d.example.com"]) {
      expect(props.onStopIgnoringHost).toHaveBeenCalledWith(host);
    }
  });

  it("collapses more than 3 focused hosts into one summary chip with a popover", () => {
    const { props } = renderChips({
      focusedHosts: new Set(["a.example.com", "b.example.com", "c.example.com", "d.example.com"]),
    });

    expect(screen.queryByText("a.example.com")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("sessionExplorer.focusedHostsSummary"));

    expect(screen.getByText("c.example.com")).toBeInTheDocument();
    expect(screen.getByText("sessionExplorer.clearAllFocusedHosts")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("sessionExplorer.unfocusHost:c.example.com"));
    expect(props.onUnfocusHost).toHaveBeenCalledWith("c.example.com");
  });
});
