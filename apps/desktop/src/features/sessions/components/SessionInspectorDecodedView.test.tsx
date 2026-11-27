import type { ScriptDecodeResult, SessionSummary } from "@aiproxy/shared-types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n";
import { decodeSessionBody, findScriptDecoders } from "@/services/commands";

import { SessionInspectorDecodedView } from "./SessionInspectorDecodedView";
import { SessionInspectorRequestPane } from "./SessionInspectorRequestPane";
import { SessionInspectorResponsePane } from "./SessionInspectorResponsePane";

vi.mock("@/services/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/commands")>()),
  decodeSessionBody: vi.fn(),
  findScriptDecoders: vi.fn(),
}));

const decoder = { ruleId: "script-1", ruleName: "ShortMax decoder" };

const session: SessionSummary = {
  durationMs: 1549,
  finishedAt: "2026-11-26T00:00:01.000Z",
  host: "api.shorttv.live",
  id: "session-1",
  method: "POST",
  path: "/app/homeData/encrypt/getTabPageData",
  protocol: "HTTP/2",
  responseMimeType: "application/json",
  sizeBytes: 290195,
  startedAt: "2026-11-26T00:00:00.000Z",
  statusCode: 200,
  url: "https://api.shorttv.live/app/homeData/encrypt/getTabPageData",
};

function decodeResult(overrides: Partial<ScriptDecodeResult> = {}): ScriptDecodeResult {
  return {
    decoded: {
      kind: "json",
      sizeBytes: 31,
      text: '{"tabId":9,"name":"何以渡輕舟"}',
      truncated: false,
    },
    durationMs: 130,
    entries: [],
    outcome: "success",
    ruleId: "script-1",
    ruleName: "ShortMax decoder",
    stage: "response",
    ...overrides,
  };
}

function renderWithProviders(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function renderView() {
  return renderWithProviders(
    <SessionInspectorDecodedView
      decoder={decoder}
      searchMatcher={null}
      session={session}
      stage="response"
    />,
  );
}

describe("SessionInspectorDecodedView", () => {
  beforeEach(() => {
    vi.mocked(decodeSessionBody).mockResolvedValue(decodeResult());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("decodes the selected stage and shows JSON as a tree first", async () => {
    renderView();

    expect(await screen.findByText("name")).toBeInTheDocument();
    expect(decodeSessionBody).toHaveBeenCalledWith("session-1", "response");
    expect(screen.getByRole("button", { name: "Tree" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/ShortMax decoder/)).toBeInTheDocument();
  });

  it("keeps integers beyond 2^53 exact in the tree", async () => {
    vi.mocked(decodeSessionBody).mockResolvedValue(
      decodeResult({
        decoded: {
          kind: "text",
          sizeBytes: 34,
          text: '{"shortPlayCode":1234567890123456789}',
          truncated: false,
        },
      }),
    );

    renderView();

    expect(await screen.findByText("1234567890123456789")).toBeInTheDocument();
  });

  it("switches to pretty-printed text", async () => {
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Text" }));

    // Highlighting splits tokens into spans, so assert on the rendered text.
    await waitFor(() => expect(document.body.textContent).toContain('"tabId": 9,'));
    expect(screen.getByRole("button", { name: "Text" })).toHaveAttribute("aria-pressed", "true");
  });

  it("explains script failures with the reported error", async () => {
    vi.mocked(decodeSessionBody).mockResolvedValue(
      decodeResult({
        decoded: null,
        entries: [{ kind: "error", level: "error", message: "bad key", sequence: 0 }],
        outcome: "runtimeError",
      }),
    );

    renderView();

    expect(
      await screen.findByText("ShortMax decoder failed to decode this message (runtimeError)."),
    ).toBeInTheDocument();
    expect(screen.getByText("bad key")).toBeInTheDocument();
  });

  it("says when the script returned nothing", async () => {
    vi.mocked(decodeSessionBody).mockResolvedValue(decodeResult({ decoded: null }));

    renderView();

    expect(
      await screen.findByText("ShortMax decoder returned no decoded value for this message."),
    ).toBeInTheDocument();
  });

  it("says when no rule decodes the message any more", async () => {
    vi.mocked(decodeSessionBody).mockResolvedValue(null);

    renderView();

    expect(
      await screen.findByText(/No enabled script rule decodes this message/),
    ).toBeInTheDocument();
  });

  it("flags truncated results", async () => {
    vi.mocked(decodeSessionBody).mockResolvedValue(
      decodeResult({
        decoded: { kind: "json", sizeBytes: 9_437_184, text: '{"tabId":9', truncated: true },
      }),
    );

    renderView();

    expect(
      await screen.findByText("The decoded value is 9.00 MB; only the first 8.00 MB is shown."),
    ).toBeInTheDocument();
  });

  it("shows script logs on demand", async () => {
    vi.mocked(decodeSessionBody).mockResolvedValue(
      decodeResult({
        entries: [
          { kind: "log", level: "info", message: "coverage", payloadJson: "1", sequence: 0 },
        ],
      }),
    );

    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Logs (1)" }));

    expect(screen.getByText("coverage")).toBeInTheDocument();
  });

  it("decodes again on demand", async () => {
    renderView();
    await screen.findByText("name");

    fireEvent.click(screen.getByRole("button", { name: "Decode again" }));

    await waitFor(() => expect(decodeSessionBody).toHaveBeenCalledTimes(2));
  });
});

describe("Decoded tab availability", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function renderResponsePane() {
    return renderWithProviders(
      <SessionInspectorResponsePane
        detail={undefined}
        isResponseBodyBase64Loading={false}
        isResponseBodyLoading={false}
        isResponseRawLoading={false}
        onResponseTabChange={vi.fn()}
        responseJsonDisplayText={undefined}
        responseJsonResult={{ status: "idle" }}
        responseTab="overview"
        session={session}
      />,
    );
  }

  function renderRequestPane() {
    return renderWithProviders(
      <SessionInspectorRequestPane
        detail={undefined}
        isRequestBodyLoading={false}
        isRequestFormLoading={false}
        isRequestRawLoading={false}
        onRequestCollapsedChange={vi.fn()}
        onRequestTabChange={vi.fn()}
        requestBodyDisplayText=""
        requestCollapsed={false}
        requestFormEntries={[]}
        requestTab="query"
        session={session}
      />,
    );
  }

  it("shows the Decoded tab only on the stage a script can decode", async () => {
    vi.mocked(findScriptDecoders).mockResolvedValue({ request: null, response: decoder });

    renderResponsePane();
    expect(await screen.findByRole("tab", { name: "Decoded" })).toBeInTheDocument();
    expect(findScriptDecoders).toHaveBeenCalledWith("POST", session.url);
  });

  it("hides the Decoded tab without a matching decoder", async () => {
    vi.mocked(findScriptDecoders).mockResolvedValue({ request: null, response: decoder });

    renderRequestPane();
    await waitFor(() => expect(findScriptDecoders).toHaveBeenCalled());
    expect(screen.queryByRole("tab", { name: "Decoded" })).not.toBeInTheDocument();
  });

  it("shows the request Decoded tab when the request can be decoded", async () => {
    vi.mocked(findScriptDecoders).mockResolvedValue({ request: decoder, response: null });

    renderRequestPane();
    expect(await screen.findByRole("tab", { name: "Decoded" })).toBeInTheDocument();
  });
});
