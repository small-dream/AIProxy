import type { RewriteSessionTrace, ScriptSessionTrace } from "@aiproxy/shared-types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n";
import {
  listMapSessionTrace,
  listRewriteSessionTrace,
  listScriptSessionTrace,
  listThrottleSessionTrace,
} from "@/services/commands";

import { SessionInspectorAutomationPane } from "./SessionInspectorAutomationPane";

vi.mock("@/services/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/commands")>()),
  listMapSessionTrace: vi.fn(),
  listRewriteSessionTrace: vi.fn(),
  listScriptSessionTrace: vi.fn(),
  listThrottleSessionTrace: vi.fn(),
}));

const LONG_JSON = JSON.stringify({
  tabId: 9,
  shortPlays: Array.from({ length: 30 }, (_, index) => ({ code: index, name: `Play ${index}` })),
});

function scriptTrace(overrides: Partial<ScriptSessionTrace> = {}): ScriptSessionTrace {
  return {
    durationMs: 130,
    entries: [
      {
        kind: "extraction",
        key: "shortmax.response",
        level: null,
        message: null,
        payloadJson: '{"tabId":9}',
        sequence: 0,
      },
    ],
    outcome: "success",
    ruleId: "a03d942d-a08e-4f09-906b-9df1156b3b57",
    ruleName: "ShortMax decoder",
    stage: "response",
    ...overrides,
  };
}

function renderPane() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SessionInspectorAutomationPane sessionId="session-1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("SessionInspectorAutomationPane", () => {
  beforeEach(() => {
    vi.mocked(listMapSessionTrace).mockResolvedValue([]);
    vi.mocked(listRewriteSessionTrace).mockResolvedValue([]);
    vi.mocked(listScriptSessionTrace).mockResolvedValue([]);
    vi.mocked(listThrottleSessionTrace).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("titles script traces with the rule name and keeps the id as secondary text", async () => {
    vi.mocked(listScriptSessionTrace).mockResolvedValue([scriptTrace()]);

    renderPane();

    expect(await screen.findByText("ShortMax decoder")).toBeInTheDocument();
    expect(screen.getByText("a03d942d-a08e-4f09-906b-9df1156b3b57")).toBeInTheDocument();
  });

  it("falls back to the rule id when the rule name is unknown", async () => {
    vi.mocked(listScriptSessionTrace).mockResolvedValue([scriptTrace({ ruleName: null })]);

    renderPane();

    expect(await screen.findAllByText("a03d942d-a08e-4f09-906b-9df1156b3b57")).toHaveLength(1);
  });

  it("pretty-prints JSON payloads", async () => {
    vi.mocked(listScriptSessionTrace).mockResolvedValue([scriptTrace()]);

    renderPane();

    const payload = await screen.findByTestId("trace-payload");
    expect(payload.textContent).toBe('{\n    "tabId": 9\n}');
  });

  it("collapses long payloads and expands them on demand", async () => {
    vi.mocked(listScriptSessionTrace).mockResolvedValue([
      scriptTrace({
        entries: [
          {
            kind: "extraction",
            key: "shortmax.response",
            payloadJson: LONG_JSON,
            sequence: 0,
          },
        ],
      }),
    ]);

    renderPane();

    const expand = await screen.findByRole("button", { name: "Show all" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("trace-payload")).toHaveAttribute("data-collapsed", "true");

    fireEvent.click(expand);

    const collapse = screen.getByRole("button", { name: "Collapse" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("trace-payload")).toHaveAttribute("data-collapsed", "false");
  });

  it("does not offer a toggle for short payloads", async () => {
    vi.mocked(listScriptSessionTrace).mockResolvedValue([scriptTrace()]);

    renderPane();

    await screen.findByTestId("trace-payload");
    expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
  });

  it("flags truncated payloads with the kept and original sizes", async () => {
    vi.mocked(listScriptSessionTrace).mockResolvedValue([
      scriptTrace({
        entries: [
          {
            kind: "extraction",
            key: "shortmax.response",
            payloadJson: '{"tabId":9,"name":"abc...',
            payloadOriginalBytes: 290_195,
            sequence: 0,
          },
        ],
      }),
    ]);

    renderPane();

    expect(
      await screen.findByText(
        /^Truncated: only the first 8\.00 KB was kept \(original 283\.39 KB\)\./,
      ),
    ).toBeInTheDocument();
  });

  it("copies the formatted payload", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.mocked(listScriptSessionTrace).mockResolvedValue([scriptTrace()]);

    renderPane();

    fireEvent.click(await screen.findByRole("button", { name: "Copy value" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{\n    "tabId": 9\n}'));
  });

  it("shows rewrite values verbatim", async () => {
    const rewrite: RewriteSessionTrace = {
      durationMs: 0,
      entries: [{ after: '"v2"', before: '"33a64df5"', kind: "header", key: "etag", sequence: 0 }],
      outcome: "success",
      rewriteType: "header",
      ruleId: "rewrite-1",
      ruleName: "etag",
      stage: "response",
    };
    vi.mocked(listRewriteSessionTrace).mockResolvedValue([rewrite]);

    renderPane();

    const values = await screen.findAllByTestId("trace-payload");
    expect(values.map((value) => value.textContent)).toEqual(['"33a64df5"', '"v2"']);
  });

  it("collapses long rewrite values such as encrypted header values", async () => {
    const rewrite: RewriteSessionTrace = {
      durationMs: 0,
      entries: [
        {
          before: "BYP5APNO8D/".repeat(200),
          kind: "header",
          key: "ci",
          message: "remove",
          sequence: 0,
        },
      ],
      outcome: "success",
      rewriteType: "header",
      ruleId: "rewrite-1",
      ruleName: "shorttv-remove-ci-header",
      stage: "request",
    };
    vi.mocked(listRewriteSessionTrace).mockResolvedValue([rewrite]);

    renderPane();

    expect(await screen.findByRole("button", { name: "Show all" })).toBeInTheDocument();
  });
});
