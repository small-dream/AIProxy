import { fireEvent, render, screen } from "@testing-library/react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { SessionInspectorMediaPreview } from "./SessionInspectorMediaPreview";

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    durationMs: 100,
    finishedAt: "2026-04-11T10:00:03.000Z",
    host: "cdn.example.com",
    id: "session-img-1",
    method: "GET",
    path: "/logo.png",
    protocol: "https",
    responseMimeType: "image/png",
    sizeBytes: 1024,
    startedAt: "2026-04-11T10:00:00.000Z",
    statusCode: 200,
    url: "https://cdn.example.com/logo.png",
    ...overrides,
  };
}

function createSessionDetail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    cookies: [],
    id: "session-img-1",
    queryParams: [],
    requestHeaders: [],
    responseHeaders: [{ name: "content-type", value: "image/png" }],
    responseBody: {
      base64Text: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      mimeType: "image/png",
      sizeBytes: 67,
    },
    summary: createSessionSummary(),
    ...overrides,
  };
}

describe("SessionInspectorMediaPreview", () => {
  it("renders an image preview from base64 data", () => {
    const detail = createSessionDetail();
    const { container } = render(
      <AppProviders>
        <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
      </AppProviders>,
    );

    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img?.getAttribute("src")).toContain("data:image/png;base64,");
  });

  it("displays metadata below the image", () => {
    const detail = createSessionDetail();

    render(
      <AppProviders>
        <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
      </AppProviders>,
    );

    expect(screen.getByText("67 bytes")).toBeInTheDocument();
  });

  it("shows a loading state when base64 is deferred and loading", () => {
    const detail = createSessionDetail({
      responseBody: {
        base64Deferred: true,
        mimeType: "image/png",
        sizeBytes: 1024,
      },
    });

    render(
      <AppProviders>
        <SessionInspectorMediaPreview detail={detail} isLoading session={createSessionSummary()} />
      </AppProviders>,
    );

    expect(screen.getByText("Loading preview...")).toBeInTheDocument();
  });

  it("shows a no-content message when response body is missing", () => {
    const detail = createSessionDetail();
    delete detail.responseBody;

    render(
      <AppProviders>
        <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
      </AppProviders>,
    );

    expect(screen.getByText("No media content available for preview.")).toBeInTheDocument();
  });

  it("shows an unsupported format message for unknown MIME types", () => {
    const detail = createSessionDetail({
      responseBody: {
        base64Text: "AAEC",
        mimeType: "application/x-custom",
        sizeBytes: 3,
      },
    });

    render(
      <AppProviders>
        <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
      </AppProviders>,
    );

    expect(screen.getByText("This media type cannot be previewed.")).toBeInTheDocument();
  });

  it("renders SVG from inlineText", () => {
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';
    const detail = createSessionDetail({
      responseBody: {
        inlineText: svgContent,
        mimeType: "image/svg+xml",
        sizeBytes: svgContent.length,
      },
    });

    const { container } = render(
      <AppProviders>
        <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
      </AppProviders>,
    );

    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img?.getAttribute("src")).toContain("data:image/svg+xml,");
  });

  it("renders audio player for audio MIME types", () => {
    const detail = createSessionDetail({
      responseBody: {
        base64Text: "AAAA",
        mimeType: "audio/mpeg",
        sizeBytes: 5000,
      },
    });

    const { container } = render(
      <AppProviders>
        <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
      </AppProviders>,
    );

    const audio = container.querySelector("audio");
    expect(audio).toBeInTheDocument();
    expect(audio?.getAttribute("src")).toContain("data:audio/mpeg;base64,");
  });

  it("renders video player for video MIME types", () => {
    const detail = createSessionDetail({
      responseBody: {
        base64Text: "AAAA",
        mimeType: "video/mp4",
        sizeBytes: 10000,
      },
    });

    render(
      <AppProviders>
        <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
      </AppProviders>,
    );

    const video = document.querySelector("video");
    expect(video).toBeInTheDocument();
    expect(video?.getAttribute("src")).toContain("data:video/mp4;base64,");
  });

  it("shows a truncated warning when body was truncated", () => {
    const detail = createSessionDetail({
      responseBody: {
        base64Text: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        mimeType: "image/png",
        sizeBytes: 5000000,
        truncated: true,
      },
    });

    render(
      <AppProviders>
        <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
      </AppProviders>,
    );

    expect(screen.getByText("Truncated")).toBeInTheDocument();
  });

  describe("context menu", () => {
    it("shows image context menu on right-click", () => {
      const detail = createSessionDetail();
      const { container } = render(
        <AppProviders>
          <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
        </AppProviders>,
      );

      const img = container.querySelector("img")!;
      fireEvent.contextMenu(img, { clientX: 100, clientY: 200 });

      expect(screen.getByText("Copy Image")).toBeInTheDocument();
      expect(screen.getByText("Save Image As...")).toBeInTheDocument();
      expect(screen.getByText("Copy Image URL")).toBeInTheDocument();
      expect(screen.getByText("Open in Browser")).toBeInTheDocument();
    });

    it("shows audio/video context menu on right-click without Copy Image", () => {
      const detail = createSessionDetail({
        responseBody: {
          base64Text: "AAAA",
          mimeType: "video/mp4",
          sizeBytes: 10000,
        },
      });

      render(
        <AppProviders>
          <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
        </AppProviders>,
      );

      const video = document.querySelector("video")!;
      fireEvent.contextMenu(video, { clientX: 100, clientY: 200 });

      expect(screen.getByText("Save As...")).toBeInTheDocument();
      expect(screen.getByText("Copy URL")).toBeInTheDocument();
      expect(screen.getByText("Open in Browser")).toBeInTheDocument();
      expect(screen.queryByText("Copy Image")).not.toBeInTheDocument();
    });

    it("closes the context menu via the menu's close handler", async () => {
      vi.stubGlobal("navigator", {
        ...navigator,
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      });

      const detail = createSessionDetail();
      const { container } = render(
        <AppProviders>
          <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
        </AppProviders>,
      );

      const img = container.querySelector("img")!;
      fireEvent.contextMenu(img, { clientX: 100, clientY: 200 });

      expect(screen.getByText("Copy Image")).toBeInTheDocument();

      fireEvent.click(screen.getByText("Copy Image URL"));

      await vi.waitFor(() => {
        expect(screen.queryByText("Copy Image")).not.toBeInTheDocument();
      });

      vi.restoreAllMocks();
    });

    it("does not show context menu when data is not loaded", () => {
      const detail = createSessionDetail();
      delete detail.responseBody;

      render(
        <AppProviders>
          <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
        </AppProviders>,
      );

      expect(screen.queryByText("Copy Image")).not.toBeInTheDocument();
      expect(screen.queryByText("Save As...")).not.toBeInTheDocument();
    });

    it("copies URL to clipboard when clicking Copy Image URL", async () => {
      const writeTextSpy = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", {
        ...navigator,
        clipboard: { writeText: writeTextSpy },
      });

      const detail = createSessionDetail();
      const { container } = render(
        <AppProviders>
          <SessionInspectorMediaPreview detail={detail} isLoading={false} session={createSessionSummary()} />
        </AppProviders>,
      );

      const img = container.querySelector("img")!;
      fireEvent.contextMenu(img, { clientX: 100, clientY: 200 });

      const copyUrlItem = screen.getByText("Copy Image URL");
      fireEvent.click(copyUrlItem);

      await vi.waitFor(() => {
        expect(writeTextSpy).toHaveBeenCalledWith("https://cdn.example.com/logo.png");
      });

      vi.restoreAllMocks();
    });
  });
});
