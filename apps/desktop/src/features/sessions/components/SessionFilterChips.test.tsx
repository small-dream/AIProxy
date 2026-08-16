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
});
