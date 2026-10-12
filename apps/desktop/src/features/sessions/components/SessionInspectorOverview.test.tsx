import { fireEvent, render, screen, within } from "@testing-library/react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { SessionInspectorOverview } from "./SessionInspectorOverview";

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 391,
    finishedAt: "2026-10-12T02:49:28.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "POST",
    path: "/books",
    protocol: "https",
    responseMimeType: "application/json",
    sizeBytes: 512,
    startedAt: "2026-10-12T02:49:27.600Z",
    statusCode: 200,
    url: "https://api.example.com/books",
    ...overrides,
  };
}

function createSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  const summary = overrides.summary ?? createSessionSummary();

  return {
    cookies: [],
    id: summary.id,
    queryParams: [],
    rawRequest: "POST /books HTTP/1.1",
    rawResponse: "HTTP/1.1 200 OK",
    requestHeaders: [],
    responseHeaders: [],
    summary,
    ...overrides,
  };
}

function renderOverview(detail: SessionDetail) {
  return render(
    <AppProviders>
      <SessionInspectorOverview detail={detail} session={detail.summary} />
    </AppProviders>,
  );
}

// A freshly dialed proxy connection: every connection phase was measured.
const PROXY_TIMING: SessionDetail["timing"] = {
  connectMs: 14,
  connectionReused: false,
  dnsMs: 6,
  responseReadMs: 9,
  tlsMs: 21,
  totalMs: 391,
  waitingMs: 344,
};

// A HAR import is the only capture path that reports how long writing the
// request took, so it is the only one that carries `requestSendMs`.
const IMPORTED_TIMING: SessionDetail["timing"] = {
  connectMs: 14,
  dnsMs: 6,
  requestSendMs: 3,
  responseReadMs: 9,
  tlsMs: 21,
  totalMs: 391,
  waitingMs: 344,
};

function timingHeader() {
  return screen.getByRole("button", { name: /Timing/ });
}

function timingSection() {
  return timingHeader().parentElement as HTMLElement;
}

function phaseAttributes(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[data-timing-phase]")).map((element) =>
    element.getAttribute("data-timing-phase"),
  );
}

describe("SessionInspectorOverview timing section", () => {
  it("reports the total in the section header and lists phases in timeline order", () => {
    renderOverview(createSessionDetail({ timing: PROXY_TIMING }));

    const section = timingSection();

    expect(timingHeader()).toHaveTextContent("391 ms");

    const labels = ["DNS", "Connect", "TLS Handshake", "Latency", "Response"];
    const rows = labels.map((label) => within(section).getByText(label));

    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1]?.compareDocumentPosition(rows[index] as Node)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }

    expect(within(section).queryByText("Request")).not.toBeInTheDocument();
    expect(within(section).queryByText("Request End Time")).not.toBeInTheDocument();
  });

  it("reports a reused pooled connection instead of 0 ms and a missing TLS phase", () => {
    renderOverview(
      createSessionDetail({
        timing: {
          connectMs: 0,
          connectionReused: true,
          dnsMs: 0,
          responseReadMs: 9,
          totalMs: 391,
          waitingMs: 344,
        },
      }),
    );

    const section = timingSection();

    // DNS, Connect, TLS Handshake: all three describe the same reused socket.
    expect(within(section).getAllByText("Connection reused")).toHaveLength(3);
    expect(within(section).queryByText("<1 ms")).not.toBeInTheDocument();
  });

  it("marks phases no capture path measured as not applicable", () => {
    renderOverview(
      createSessionDetail({ timing: { responseReadMs: 0, totalMs: 12, waitingMs: 12 } }),
    );

    const section = timingSection();

    expect(within(section).getAllByText("N/A")).toHaveLength(3);
    expect(within(section).queryByText("Connection reused")).not.toBeInTheDocument();
  });

  it("only lists the request send rows when the timing carries them", () => {
    const { unmount } = renderOverview(
      createSessionDetail({
        timing: IMPORTED_TIMING,
        summary: createSessionSummary({ id: "imported-har-1" }),
      }),
    );

    const importedSection = timingSection();

    expect(within(importedSection).getByText("Request")).toBeInTheDocument();
    expect(within(importedSection).getByText("3 ms")).toBeInTheDocument();
    expect(within(importedSection).getByText("Request Speed")).toBeInTheDocument();
    expect(within(importedSection).getByText("Request End Time")).toBeInTheDocument();

    unmount();

    renderOverview(createSessionDetail({ timing: PROXY_TIMING }));

    expect(within(timingSection()).queryByText("Request Speed")).not.toBeInTheDocument();
  });

  it("draws one segment per measured phase and none for unmeasured phases", () => {
    const { container } = renderOverview(
      createSessionDetail({ timing: { totalMs: 391, waitingMs: 344 } }),
    );

    expect(phaseAttributes(container)).toEqual(["wait"]);
  });

  it("dims the other segments while a phase row is hovered", () => {
    const { container } = renderOverview(createSessionDetail({ timing: PROXY_TIMING }));
    const row = container.querySelector('[data-phase-row="wait"]');

    fireEvent.mouseEnter(row as Element);

    expect(container.querySelector('[data-timing-phase="wait"]')).toHaveStyle({ opacity: "1" });
    expect(container.querySelector('[data-timing-phase="dns"]')).toHaveStyle({ opacity: "0.3" });
    expect(container.querySelector('[data-timing-phase="download"]')).toHaveStyle({
      opacity: "0.3",
    });

    fireEvent.mouseLeave(row as Element);

    expect(container.querySelector('[data-timing-phase="dns"]')).toHaveStyle({ opacity: "1" });
  });
});
