import { fireEvent, render, screen, within } from "@testing-library/react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { SessionInspectorWorkspace } from "./SessionInspectorWorkspace";

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 165,
    finishedAt: "2026-04-11T10:00:03.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "POST",
    path: "/books",
    protocol: "https",
    responseMimeType: "application/json",
    sizeBytes: 512,
    startedAt: "2026-04-11T10:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/books",
    ...overrides,
  };
}

function createSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    cookies: [],
    id: "session-1",
    queryParams: [{ name: "page", value: "1" }],
    rawRequest: "POST /books HTTP/1.1",
    rawResponse: "HTTP/1.1 200 OK",
    requestBody: {
      inlineText: "{\"title\":\"AI\"}",
      mimeType: "application/json",
      sizeBytes: 14,
    },
    requestHeaders: [{ name: "content-type", value: "application/json" }],
    responseBody: {
      inlineText: "{\"ok\":true}",
      mimeType: "application/json",
      sizeBytes: 11,
    },
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    summary: createSessionSummary(),
    ...overrides,
  };
}

function createMultipartRequestBody() {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    "--boundary\r\n"
      + "Content-Disposition: form-data; name=\"email\"\r\n\r\n"
      + "user@example.com\r\n"
      + "--boundary\r\n"
      + "Content-Disposition: form-data; name=\"Filedata\"; filename=\"submit.gz\"\r\n"
      + "Content-Type: application/gzip\r\n\r\n",
  );
  const fileBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
  const tail = encoder.encode("\r\n--boundary--\r\n");
  const payloadBytes = new Uint8Array(head.length + fileBytes.length + tail.length);

  payloadBytes.set(head, 0);
  payloadBytes.set(fileBytes, head.length);
  payloadBytes.set(tail, head.length + fileBytes.length);

  return {
    base64Text: Buffer.from(payloadBytes).toString("base64"),
    mimeType: "multipart/form-data",
    sizeBytes: payloadBytes.length,
  };
}

function createWebSocketSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return createSessionSummary({
    protocol: "wss",
    responseMimeType: "websocket",
    statusCode: 101,
    ...overrides,
  });
}

function createWebSocketSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  const detail = createSessionDetail({
    summary: createWebSocketSessionSummary(),
    ...overrides,
  });

  delete detail.responseBody;

  return detail;
}

describe("SessionInspectorWorkspace", () => {
  it("renders websocket response tabs in the preferred order", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="query"
          responseTab="overview"
          selectedSession={createWebSocketSessionSummary()}
          selectedSessionDetail={createWebSocketSessionDetail()}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const responseTabList = screen.getAllByRole("tablist")[1];
    const responseTabs = within(responseTabList as HTMLElement).getAllByRole("tab");

    expect(responseTabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Messages",
      "Headers (1)",
      "Raw",
    ]);
  });

  it("renders JSON response tabs in the preferred order", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="query"
          responseTab="overview"
          selectedSession={createSessionSummary()}
          selectedSessionDetail={createSessionDetail()}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const responseTabList = screen.getAllByRole("tablist")[1];
    const responseTabs = within(responseTabList as HTMLElement).getAllByRole("tab");

    expect(responseTabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "JSON",
      "JSON Text",
      "Headers (1)",
      "Raw",
      "Automation",
    ]);
  });

  it("shows captured response timing and marks unsupported proxy timing phases unavailable", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="query"
          responseTab="overview"
          selectedSession={createSessionSummary({
            durationMs: 5200,
            finishedAt: "2026-04-11T10:00:05.200Z",
          })}
          selectedSessionDetail={createSessionDetail({
            clientAddress: "127.0.0.1:54321",
            summary: createSessionSummary({
              durationMs: 5200,
              finishedAt: "2026-04-11T10:00:05.200Z",
            }),
            tlsCipherSuite: "TLS_AES_128_GCM_SHA256",
            tlsProtocol: "TLSv1.3",
            timing: {
              responseReadMs: 0,
              totalMs: 5200,
              waitingMs: 5000,
            },
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    expect(screen.getByText("127.0.0.1:54321")).toBeInTheDocument();
    expect(screen.getByText("TLSv1.3 (TLS_AES_128_GCM_SHA256)")).toBeInTheDocument();
    expect(screen.getByText("<1 ms")).toBeInTheDocument();
    expect(screen.getByText("5000 ms")).toBeInTheDocument();
    expect(screen.queryByText("Connection")).not.toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(3);
  });

  it("renders text response tabs in the preferred order", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="query"
          responseTab="overview"
          selectedSession={createSessionSummary({ responseMimeType: "text/plain" })}
          selectedSessionDetail={createSessionDetail({
            responseBody: {
              inlineText: "hello world",
              mimeType: "text/plain",
              sizeBytes: 11,
            },
            summary: createSessionSummary({ responseMimeType: "text/plain" }),
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const responseTabList = screen.getAllByRole("tablist")[1];
    const responseTabs = within(responseTabList as HTMLElement).getAllByRole("tab");

    expect(responseTabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Text",
      "Headers (1)",
      "Raw",
      "Automation",
    ]);
  });

  it("renders binary response tabs in the preferred order", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="query"
          responseTab="overview"
          selectedSession={createSessionSummary({ responseMimeType: "application/octet-stream" })}
          selectedSessionDetail={createSessionDetail({
            responseBody: {
              base64Text: "AAEC",
              mimeType: "application/octet-stream",
              sizeBytes: 3,
            },
            summary: createSessionSummary({ responseMimeType: "application/octet-stream" }),
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const responseTabList = screen.getAllByRole("tablist")[1];
    const responseTabs = within(responseTabList as HTMLElement).getAllByRole("tab");

    expect(responseTabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Headers (1)",
      "Raw",
      "Automation",
    ]);
  });

  it("renders Preview tab for image responses", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="query"
          responseTab="overview"
          selectedSession={createSessionSummary({ responseMimeType: "image/png" })}
          selectedSessionDetail={createSessionDetail({
            responseBody: {
              mimeType: "image/png",
              sizeBytes: 1024,
            },
            summary: createSessionSummary({ responseMimeType: "image/png" }),
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const responseTabList = screen.getAllByRole("tablist")[1];
    const responseTabs = within(responseTabList as HTMLElement).getAllByRole("tab");

    expect(responseTabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Preview",
      "Headers (1)",
    ]);
  });

  it("renders Preview tab alongside Text tab for SVG responses", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="query"
          responseTab="overview"
          selectedSession={createSessionSummary({ responseMimeType: "image/svg+xml" })}
          selectedSessionDetail={createSessionDetail({
            responseBody: {
              inlineText: "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"10\"/></svg>",
              mimeType: "image/svg+xml",
              sizeBytes: 60,
            },
            summary: createSessionSummary({ responseMimeType: "image/svg+xml" }),
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const responseTabList = screen.getAllByRole("tablist")[1];
    const responseTabs = within(responseTabList as HTMLElement).getAllByRole("tab");

    expect(responseTabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Preview",
      "Text",
      "Headers (1)",
    ]);
  });

  it("renders Preview tab for audio/video responses", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="query"
          responseTab="overview"
          selectedSession={createSessionSummary({ responseMimeType: "video/mp4" })}
          selectedSessionDetail={createSessionDetail({
            responseBody: {
              base64Text: "AAAA",
              mimeType: "video/mp4",
              sizeBytes: 5000,
            },
            summary: createSessionSummary({ responseMimeType: "video/mp4" }),
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const responseTabList = screen.getAllByRole("tablist")[1];
    const responseTabs = within(responseTabList as HTMLElement).getAllByRole("tab");

    expect(responseTabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Preview",
      "Headers (1)",
    ]);
  });

  it("does not render Preview tab for non-media binary responses", () => {
    const handleResponseTabChange = vi.fn();

    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={handleResponseTabChange}
          requestCollapsed={false}
          requestTab="query"
          responseTab="json"
          selectedSession={createSessionSummary({ responseMimeType: "application/octet-stream" })}
          selectedSessionDetail={createSessionDetail({
            responseBody: {
              base64Text: "AAEC",
              mimeType: "application/octet-stream",
              sizeBytes: 3,
            },
            summary: createSessionSummary({ responseMimeType: "application/octet-stream" }),
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    expect(handleResponseTabChange).toHaveBeenCalledWith("overview");
  });

  it("renders request tabs in the preferred order", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="query"
          responseTab="overview"
          selectedSession={createSessionSummary()}
          selectedSessionDetail={createSessionDetail()}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const requestTabList = screen.getAllByRole("tablist")[0];
    const requestTabs = within(requestTabList as HTMLElement).getAllByRole("tab");

    expect(requestTabs.map((tab) => tab.textContent)).toEqual([
      "Query (1)",
      "Form",
      "Body",
      "Headers (1)",
      "Raw",
    ]);
  });

  it("syntax highlights JSON request bodies", () => {
    const { container } = render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="body"
          responseTab="overview"
          selectedSession={createSessionSummary()}
          selectedSessionDetail={createSessionDetail({
            requestBody: {
              inlineText: "{\"title\":\"AI\",\"published\":true}",
              mimeType: "application/json; charset=utf-8",
              sizeBytes: 31,
            },
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const codeBlock = container.querySelector("pre");

    expect(codeBlock).toHaveTextContent('"title"');
    expect(codeBlock?.querySelectorAll("span").length).toBeGreaterThan(0);
  });

  it("does not show request body metadata in the body tab", () => {
    const { container } = render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="body"
          responseTab="overview"
          selectedSession={createSessionSummary({ responseMimeType: "text/plain" })}
          selectedSessionDetail={createSessionDetail({
            requestBody: {
              inlineText: "{\"title\":\"AI\"}",
              mimeType: "application/json",
              sizeBytes: 14,
            },
            responseBody: {
              inlineText: "ok",
              mimeType: "text/plain",
              sizeBytes: 2,
            },
            responseHeaders: [{ name: "content-type", value: "text/plain" }],
            summary: createSessionSummary({ responseMimeType: "text/plain" }),
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );
    const codeBlock = container.querySelector("pre");
    const requestBodyContent = codeBlock?.parentElement;

    expect(requestBodyContent).not.toHaveTextContent("application/json - 14 bytes");
    expect(screen.getByText(/"title"/)).toBeInTheDocument();
  });

  it("renders the draggable splitter and forwards pointer down events", () => {
    const handleInspectorResizeStart = vi.fn();

    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={handleInspectorResizeStart}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="headers"
          responseTab="overview"
          selectedSession={createSessionSummary()}
          selectedSessionDetail={createSessionDetail()}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    const grid = screen.getByTestId("session-inspector-grid");
    const splitter = screen.getByTestId("session-inspector-splitter");

    expect(grid).toHaveStyle({ gridTemplateRows: "0.4fr 1px 0.6fr" });

    fireEvent.pointerDown(splitter, { clientY: 200, pointerId: 1 });

    expect(handleInspectorResizeStart).toHaveBeenCalledTimes(1);
  });

  it("hides the splitter and uses the collapsed layout when the request pane is collapsed", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed
          requestTab="headers"
          responseTab="overview"
          selectedSession={createSessionSummary()}
          selectedSessionDetail={createSessionDetail()}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    expect(screen.queryByTestId("session-inspector-splitter")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-inspector-grid")).toHaveStyle({
      gridTemplateRows: "auto 1px minmax(0, 1fr)",
    });
  });

  it("shows multipart file entries as file metadata in the form tab", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="form"
          responseTab="overview"
          selectedSession={createSessionSummary()}
          selectedSessionDetail={createSessionDetail({
            requestBody: createMultipartRequestBody(),
            requestHeaders: [{ name: "content-type", value: "multipart/form-data; boundary=boundary" }],
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    expect(screen.getByText("submit.gz")).toBeInTheDocument();
    expect(screen.getByText("application/gzip")).toBeInTheDocument();
    expect(screen.getByText("4 B (4 bytes)")).toBeInTheDocument();
    expect(screen.queryByText("Name")).not.toBeInTheDocument();
    expect(screen.queryByText("Content Type")).not.toBeInTheDocument();
    expect(screen.queryByText("Filename")).not.toBeInTheDocument();
    expect(screen.queryByText("Value")).not.toBeInTheDocument();
  });

  it("does not show request body metadata in the form tab", () => {
    render(
      <AppProviders>
        <SessionInspectorWorkspace
          detailErrorMessage={undefined}
          inspectorSplitRatio={0.4}
          isDetailLoading={false}
          onCopyCurl={undefined}
          onCopyUrl={undefined}
          onInspectorResizeStart={() => {}}
          onRepeat={undefined}
          onRequestCollapsedChange={() => {}}
          onRequestTabChange={() => {}}
          onResponseTabChange={() => {}}
          requestCollapsed={false}
          requestTab="form"
          responseTab="overview"
          selectedSession={createSessionSummary()}
          selectedSessionDetail={createSessionDetail({
            requestBody: {
              inlineText: "name=pharles&mode=debug",
              mimeType: "application/x-www-form-urlencoded",
              sizeBytes: 23,
            },
          })}
          sessionSelectionNonce={0}
        />
      </AppProviders>,
    );

    expect(screen.queryByText(/application\/x-www-form-urlencoded/)).not.toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("pharles")).toBeInTheDocument();
  });
});
