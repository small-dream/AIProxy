import type { SessionSummary } from "@aiproxy/shared-types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n";

import { SessionInspectorResponsePane } from "./SessionInspectorResponsePane";
import type { ResponseInspectorTab } from "./session-inspector.helpers";

type PaneOptions = {
  onResponseTabChange: (tab: ResponseInspectorTab) => void;
  responseTab: ResponseInspectorTab;
  session: SessionSummary;
};

function createSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 12,
    finishedAt: "2026-11-01T00:00:01.000Z",
    host: "api.example.com",
    id: "session-image",
    method: "GET",
    path: "/image.png",
    protocol: "HTTP/1.1",
    responseMimeType: "image/png",
    sizeBytes: 128,
    startedAt: "2026-11-01T00:00:00.000Z",
    statusCode: 200,
    url: "https://api.example.com/image.png",
    ...overrides,
  };
}

function paneQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function paneElement(queryClient: QueryClient, options: PaneOptions) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SessionInspectorResponsePane
          detail={undefined}
          isResponseBodyBase64Loading={false}
          isResponseBodyLoading={false}
          isResponseRawLoading={false}
          onResponseTabChange={options.onResponseTabChange}
          responseJsonDisplayText={undefined}
          responseJsonResult={{ status: "idle" }}
          responseMeta={undefined}
          responseTab={options.responseTab}
          session={options.session}
        />
      </I18nProvider>
    </QueryClientProvider>
  );
}

// P2-9: a media response opens on the preview tab, but only once per session.
// The old effect re-ran whenever `responseTab` changed, so clicking "Overview"
// was immediately undone and that tab could never be reached.
describe("SessionInspectorResponsePane media auto-preview", () => {
  it("opens a media response on preview, then leaves the chosen tab alone", () => {
    const queryClient = paneQueryClient();
    const onResponseTabChange = vi.fn();
    const session = createSession();

    const view = render(
      paneElement(queryClient, { onResponseTabChange, responseTab: "overview", session }),
    );

    // Initial mount with the default "overview" tab → auto-open preview.
    expect(onResponseTabChange).toHaveBeenCalledTimes(1);
    expect(onResponseTabChange).toHaveBeenCalledWith("preview");

    // The parent applied "preview".
    view.rerender(
      paneElement(queryClient, { onResponseTabChange, responseTab: "preview", session }),
    );
    expect(onResponseTabChange).toHaveBeenCalledTimes(1);

    // User explicitly selects "Overview" → the pane must not bounce back.
    view.rerender(
      paneElement(queryClient, { onResponseTabChange, responseTab: "overview", session }),
    );
    expect(onResponseTabChange).toHaveBeenCalledTimes(1);

    // A different session opens on preview again.
    view.rerender(
      paneElement(queryClient, {
        onResponseTabChange,
        responseTab: "overview",
        session: createSession({ id: "session-image-2", path: "/other.png" }),
      }),
    );
    expect(onResponseTabChange).toHaveBeenCalledTimes(2);
    expect(onResponseTabChange).toHaveBeenLastCalledWith("preview");
  });
});
