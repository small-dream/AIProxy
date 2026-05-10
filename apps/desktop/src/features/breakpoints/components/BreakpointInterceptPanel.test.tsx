import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BreakpointHit } from "@aiproxy/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { resolveBreakpoint } from "@/services/commands";

import { useBreakpointStore } from "../breakpoint.store";
import { BreakpointInterceptPanel } from "./BreakpointInterceptPanel";

vi.mock("@/services/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/commands")>();

  return {
    ...actual,
    resolveBreakpoint: vi.fn().mockResolvedValue(undefined),
  };
});

function createHit(overrides: Partial<BreakpointHit> = {}): BreakpointHit {
  return {
    host: "pb.photoaffections.com",
    method: "POST",
    path: "/api/?_method=app.launch&_app=Android-PBUS-3.14.0",
    requestBody: {
      inlineText: "_sessionKey=abc&client_params=%7B%22request_id%22%3A%221%22%7D",
      mimeType: "application/x-www-form-urlencoded",
      sizeBytes: 68,
    },
    requestHeaders: [
      { name: "Content-Type", value: "application/x-www-form-urlencoded" },
      { name: "Host", value: "pb.photoaffections.com" },
    ],
    sessionId: "breakpoint-1",
    stage: "request",
    url: "https://pb.photoaffections.com/api/?_method=app.launch&_app=Android-PBUS-3.14.0",
    ...overrides,
  };
}

function renderPanel(hit: BreakpointHit = createHit()) {
  useBreakpointStore.setState({
    activeHitId: hit.sessionId,
    pendingHits: [hit],
    rules: [],
  });

  return render(
    <AppProviders>
      <BreakpointInterceptPanel />
    </AppProviders>,
  );
}

describe("BreakpointInterceptPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBreakpointStore.setState({ activeHitId: null, pendingHits: [], rules: [] });
  });

  it("renders the intercepted exchange as a compact workbench", () => {
    renderPanel();

    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("Request")).toBeInTheDocument();
    expect(screen.getByText("pb.photoaffections.com")).toBeInTheDocument();
    expect(screen.getByText("/api/?_method=app.launch&_app=Android-PBUS-3.14.0")).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Query" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Query (2)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Response Status" })).toBeDisabled();
    expect(screen.getByText("2 params")).toBeInTheDocument();
  });

  it("sends edited request query, headers, and body when forwarding", async () => {
    renderPanel();

    fireEvent.change(screen.getByDisplayValue("_method"), { target: { value: "debug" } });
    fireEvent.change(screen.getByDisplayValue("app.launch"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("tab", { name: "Request Headers (2)" }));
    fireEvent.change(screen.getByDisplayValue("Content-Type"), { target: { value: "X-Debug" } });
    fireEvent.change(screen.getByDisplayValue("application/x-www-form-urlencoded"), { target: { value: "true" } });
    fireEvent.click(screen.getByRole("tab", { name: "Request Body" }));
    fireEvent.change(screen.getByLabelText("Request Body"), { target: { value: "edited-body" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(resolveBreakpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "forward",
          modifiedRequestHeaders: expect.arrayContaining([{ name: "X-Debug", value: "true" }]),
          modifiedRequestQueryParams: expect.arrayContaining([{ name: "debug", value: "1" }]),
          modifiedRequestBodyBase64: btoa("edited-body"),
          sessionId: "breakpoint-1",
        }),
      );
    });
  });

  it("sends edited response status, headers, and body when forwarding a response breakpoint", async () => {
    renderPanel(createHit({
      responseBody: {
        inlineText: "{\"ok\":true}",
        mimeType: "application/json",
        sizeBytes: 11,
      },
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      responseStatusCode: 200,
      sessionId: "breakpoint-response",
      stage: "response",
    }));

    const responsePane = screen.getByTestId("breakpoint-response-pane");

    fireEvent.click(within(responsePane).getByRole("tab", { name: "Response Status" }));
    fireEvent.change(within(responsePane).getByLabelText("Response Status"), { target: { value: "418" } });
    fireEvent.click(within(responsePane).getByRole("tab", { name: "Response Headers (1)" }));
    fireEvent.change(within(responsePane).getByDisplayValue("Content-Type"), { target: { value: "X-Response" } });
    fireEvent.change(within(responsePane).getByDisplayValue("application/json"), { target: { value: "changed" } });
    fireEvent.click(within(responsePane).getByRole("tab", { name: "Response Body" }));
    fireEvent.change(within(responsePane).getByLabelText("Response Body"), { target: { value: "{\"changed\":true}" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(resolveBreakpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "forward",
          modifiedResponseBodyBase64: btoa("{\"changed\":true}"),
          modifiedResponseHeaders: [{ name: "X-Response", value: "changed" }],
          modifiedResponseStatusCode: 418,
          sessionId: "breakpoint-response",
        }),
      );
    });
  });

  it("switches to mock response editing and sends mock resolution", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Mock Response" }));

    expect(screen.getByText("Mock mode")).toBeInTheDocument();

    const responsePane = screen.getByTestId("breakpoint-response-pane");
    fireEvent.change(within(responsePane).getByLabelText("Response Body"), { target: { value: "{\"ok\":true}" } });
    fireEvent.click(screen.getByRole("button", { name: "Send Mock" }));

    await waitFor(() => {
      expect(resolveBreakpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "mock",
          mock: expect.objectContaining({
            bodyBase64: btoa("{\"ok\":true}"),
            statusCode: 200,
          }),
          sessionId: "breakpoint-1",
        }),
      );
    });
  });
});
