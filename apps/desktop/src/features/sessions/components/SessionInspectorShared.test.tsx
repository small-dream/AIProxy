import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n";
import { SearchableCodeBlock } from "./SessionInspectorShared";

function createLargeCodeBlock() {
  return Array.from({ length: 400 }, (_value, index) => `line ${index} match`).join("\n");
}

function renderWithProviders(ui: React.ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

function mockWindowSelection(text: string) {
  return vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => text,
  } as Selection);
}

describe("SearchableCodeBlock", () => {
  it("virtualizes large content when search is inactive", () => {
    const { container } = renderWithProviders(
      <SearchableCodeBlock code={createLargeCodeBlock()} searchQuery="" />,
    );

    expect(container).not.toHaveTextContent("line 399 match");
  });

  it("keeps virtualized content width stable without canvas text measurement", () => {
    const createElementSpy = vi.spyOn(document, "createElement");

    renderWithProviders(<SearchableCodeBlock code={createLargeCodeBlock()} searchQuery="" />);

    expect(createElementSpy).not.toHaveBeenCalledWith("canvas");

    createElementSpy.mockRestore();
  });

  it("keeps large content virtualized while scrolling to the first matching off-screen line", () => {
    const { container } = renderWithProviders(
      <SearchableCodeBlock code={createLargeCodeBlock()} searchQuery="line 399" />,
    );
    const scrollContainer = container.firstChild as HTMLDivElement | null;

    expect(container).toHaveTextContent("line 399");
    expect(scrollContainer?.scrollTop ?? 0).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent("line 0 match");
  });

  it("uses full-text match positions for JSON syntax-highlighted search marks", () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const code = '{\n  "status": "ok",\n  "target": "needle"\n}';
    const targetIndex = code.indexOf("needle");
    const matcher = (text: string) => {
      const index = text.indexOf("needle");
      return index === -1 ? [] : [{ start: index, end: index + "needle".length }];
    };

    const { container } = renderWithProviders(
      <SearchableCodeBlock
        code={code}
        currentMatchIndex={0}
        language="json"
        matcher={matcher}
        searchQuery=""
      />,
    );

    const targetMark = container.querySelector(`mark[data-match-index="${targetIndex}"]`);

    expect(targetMark).toHaveTextContent("needle");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    scrollIntoView.mockRestore();
  });

  it("keeps JSON search positioning when a match spans syntax tokens", () => {
    const code = '{\n  "status": "ok",\n  "target": "needle"\n}';
    const query = '"target": "needle"';
    const targetIndex = code.indexOf(query);
    const matcher = (text: string) => {
      const index = text.indexOf(query);
      return index === -1 ? [] : [{ start: index, end: index + query.length }];
    };

    const { container } = renderWithProviders(
      <SearchableCodeBlock
        code={code}
        currentMatchIndex={0}
        language="json"
        matcher={matcher}
        searchQuery=""
      />,
    );

    expect(
      container.querySelector(`mark[data-match-index="${targetIndex}"]`),
    ).toBeInTheDocument();
  });

  it("reuses full-text matches for non-virtualized JSON highlighting", () => {
    const code = '{\n  "status": "ok",\n  "target": "needle"\n}';
    const matcher = vi.fn((text: string) => {
      const index = text.indexOf("needle");
      return index === -1 ? [] : [{ start: index, end: index + "needle".length }];
    });

    renderWithProviders(
      <SearchableCodeBlock
        code={code}
        currentMatchIndex={0}
        language="json"
        matcher={matcher}
        searchQuery=""
      />,
    );

    expect(matcher).toHaveBeenCalledTimes(1);
    expect(matcher).toHaveBeenCalledWith(code);
  });

  describe("context menu", () => {
    it("shows Copy and Search options when right-clicking with selected text", () => {
      const getSelectionSpy = mockWindowSelection("hello");

      renderWithProviders(
        <SearchableCodeBlock code="hello world" onSearchWithText={vi.fn()} searchQuery="" />,
      );

      act(() => {
        fireEvent.contextMenu(document.querySelector("pre")!, { clientX: 100, clientY: 100 });
      });

      expect(screen.getByText("Copy")).toBeInTheDocument();
      expect(screen.getByText("Search")).toBeInTheDocument();

      getSelectionSpy.mockRestore();
    });

    it("copies selected text to clipboard when Copy is clicked", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);

      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });

      const getSelectionSpy = mockWindowSelection("selected text to copy");

      renderWithProviders(<SearchableCodeBlock code="selected text to copy" searchQuery="" />);

      act(() => {
        fireEvent.contextMenu(document.querySelector("pre")!, { clientX: 100, clientY: 100 });
      });
      act(() => {
        fireEvent.click(screen.getByText("Copy"));
      });

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("selected text to copy");
      });

      getSelectionSpy.mockRestore();
    });

    it("calls onSearchWithText with selected text when Search is clicked", () => {
      const onSearchWithText = vi.fn();
      const getSelectionSpy = mockWindowSelection("search this");

      renderWithProviders(
        <SearchableCodeBlock
          code="search this term"
          onSearchWithText={onSearchWithText}
          searchQuery=""
        />,
      );

      act(() => {
        fireEvent.contextMenu(document.querySelector("pre")!, { clientX: 100, clientY: 100 });
      });
      act(() => {
        fireEvent.click(screen.getByText("Search"));
      });

      expect(onSearchWithText).toHaveBeenCalledWith("search this");

      getSelectionSpy.mockRestore();
    });

    it("does not show context menu when no text is selected", () => {
      const getSelectionSpy = mockWindowSelection("");

      renderWithProviders(<SearchableCodeBlock code="hello world" searchQuery="" />);

      act(() => {
        fireEvent.contextMenu(document.querySelector("pre")!, { clientX: 100, clientY: 100 });
      });

      expect(screen.queryByText("Copy")).not.toBeInTheDocument();
      expect(screen.queryByText("Search")).not.toBeInTheDocument();

      getSelectionSpy.mockRestore();
    });

    it("hides Search option when onSearchWithText is not provided", () => {
      const getSelectionSpy = mockWindowSelection("text");

      renderWithProviders(<SearchableCodeBlock code="text content" searchQuery="" />);

      act(() => {
        fireEvent.contextMenu(document.querySelector("pre")!, { clientX: 100, clientY: 100 });
      });

      expect(screen.getByText("Copy")).toBeInTheDocument();
      expect(screen.queryByText("Search")).not.toBeInTheDocument();

      getSelectionSpy.mockRestore();
    });

    it("shows context menu on virtualized content with selected text", () => {
      const onSearchWithText = vi.fn();
      const getSelectionSpy = mockWindowSelection("needle");

      const { container } = renderWithProviders(
        <SearchableCodeBlock
          code={createLargeCodeBlock()}
          onSearchWithText={onSearchWithText}
          searchQuery=""
        />,
      );

      const virtualContainer = container.firstChild as HTMLElement;

      act(() => {
        fireEvent.contextMenu(virtualContainer, { clientX: 100, clientY: 100 });
      });

      expect(screen.getByText("Copy")).toBeInTheDocument();
      expect(screen.getByText("Search")).toBeInTheDocument();

      getSelectionSpy.mockRestore();
    });
  });
});
