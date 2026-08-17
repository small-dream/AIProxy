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
    host: "api.example.com",
    method: "POST",
    path: "/api/?_method=app.launch&_app=Android-PBUS-3.14.0",
    requestBody: {
      inlineText: "_sessionKey=abc&client_params=%7B%22request_id%22%3A%221%22%7D",
      mimeType: "application/x-www-form-urlencoded",
      sizeBytes: 68,
    },
    requestHeaders: [
      { name: "Content-Type", value: "application/x-www-form-urlencoded" },
      { name: "Host", value: "api.example.com" },
    ],
    sessionId: "breakpoint-1",
    stage: "request",
    url: "https://api.example.com/api/?_method=app.launch&_app=Android-PBUS-3.14.0",
    ...overrides,
  };
}

function renderPanel(hit: BreakpointHit = createHit()) {
  useBreakpointStore.setState({
    activeHitId: hit.sessionId,
    pendingHits: [{ ...hit, receivedAt: Date.now() }],
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
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(
      screen.getByText("/api/?_method=app.launch&_app=Android-PBUS-3.14.0"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Query" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Query" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Status" })).toBeDisabled();
    expect(screen.getByText("2 params")).toBeInTheDocument();
  });

  it("sends edited request query, headers, and body when forwarding", async () => {
    renderPanel();

    fireEvent.change(screen.getByDisplayValue("_method"), { target: { value: "debug" } });
    fireEvent.change(screen.getByDisplayValue("app.launch"), { target: { value: "1" } });
    const requestTabList = screen.getAllByRole("tablist")[0];
    if (!requestTabList) throw new Error("Request tablist not found");
    fireEvent.click(within(requestTabList).getByRole("tab", { name: "Headers" }));
    fireEvent.change(screen.getByDisplayValue("Content-Type"), { target: { value: "X-Debug" } });
    fireEvent.change(screen.getByDisplayValue("application/x-www-form-urlencoded"), {
      target: { value: "true" },
    });
    const requestBodyTab = screen.getAllByRole("tab", { name: "Body" })[0];
    if (!requestBodyTab) throw new Error("Request body tab not found");
    fireEvent.click(requestBodyTab);
    fireEvent.change(screen.getByDisplayValue("abc"), { target: { value: "edited-body" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(resolveBreakpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "forward",
          modifiedRequestHeaders: expect.arrayContaining([{ name: "X-Debug", value: "true" }]),
          modifiedRequestQueryParams: expect.arrayContaining([{ name: "debug", value: "1" }]),
          modifiedRequestBodyBase64: btoa(
            "_sessionKey=edited-body&client_params=%7B%22request_id%22%3A%221%22%7D",
          ),
          sessionId: "breakpoint-1",
        }),
      );
    });
  });

  it("sends edited response status, headers, and body when forwarding a response breakpoint", async () => {
    renderPanel(
      createHit({
        responseBody: {
          inlineText: '{"ok":true}',
          mimeType: "application/json",
          sizeBytes: 11,
        },
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        responseStatusCode: 200,
        sessionId: "breakpoint-response",
        stage: "response",
      }),
    );

    const responsePane = screen.getByTestId("breakpoint-response-pane");

    fireEvent.click(within(responsePane).getByRole("tab", { name: "Status" }));
    fireEvent.change(within(responsePane).getByLabelText("Status"), { target: { value: "418" } });
    fireEvent.click(within(responsePane).getByRole("tab", { name: "Headers" }));
    fireEvent.change(within(responsePane).getByDisplayValue("Content-Type"), {
      target: { value: "X-Response" },
    });
    fireEvent.change(within(responsePane).getByDisplayValue("application/json"), {
      target: { value: "changed" },
    });
    fireEvent.click(within(responsePane).getByRole("tab", { name: "Body" }));
    fireEvent.change(
      within(responsePane)
        .getAllByLabelText("Body")
        .find((element) => element.tagName === "TEXTAREA")!,
      { target: { value: '{"changed":true}' } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(resolveBreakpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "forward",
          modifiedResponseBodyBase64: btoa('{"changed":true}'),
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
    fireEvent.change(
      within(responsePane)
        .getAllByLabelText("Body")
        .find((element) => element.tagName === "TEXTAREA")!,
      { target: { value: '{"ok":true}' } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send Mock" }));

    await waitFor(() => {
      expect(resolveBreakpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "mock",
          mock: expect.objectContaining({
            bodyBase64: btoa('{"ok":true}'),
            statusCode: 200,
          }),
          sessionId: "breakpoint-1",
        }),
      );
    });
  });

  it("blocks Send Mock and surfaces an error when the mock status code is empty (L9)", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Mock Response" }));

    const responsePane = screen.getByTestId("breakpoint-response-pane");
    fireEvent.click(within(responsePane).getByRole("tab", { name: "Status" }));
    fireEvent.change(within(responsePane).getByLabelText("Status"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Send Mock" }));

    // Must NOT silently fall back to 200 / call the backend.
    await Promise.resolve();
    expect(resolveBreakpoint).not.toHaveBeenCalled();

    // Must surface a visible error so the user knows why nothing was sent.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});
