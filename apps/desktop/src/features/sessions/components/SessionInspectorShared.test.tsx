import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { I18nProvider } from "@/i18n";
import { InspectorKeyValueTable, SearchableCodeBlock } from "./SessionInspectorShared";

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

function findTextNode(container: HTMLElement, text: string): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    if (node.textContent?.includes(text)) {
      return node as Text;
    }
    node = walker.nextNode();
  }

  throw new Error(`Text node not found: ${text}`);
}

// jsdom has no hit testing, so the pointer position is stubbed with the caret
// range the real engine would return for the same coordinates.
function mockCaretRangeFromPoint(position: { node: Node; offset: number } | null) {
  Object.defineProperty(document, "caretRangeFromPoint", {
    configurable: true,
    value: vi.fn(() => {
      if (!position) return null;
      const range = document.createRange();
      range.setStart(position.node, position.offset);
      range.collapse(true);
      return range;
    }),
  });
}

function mockWritableSelection(text = "") {
  const ranges: Range[] = [];
  vi.spyOn(window, "getSelection").mockReturnValue({
    addRange: (range: Range) => {
      ranges.push(range);
    },
    removeAllRanges: vi.fn(),
    toString: () => text,
  } as unknown as Selection);

  return ranges;
}

// The real engines hand the block a live `Range` for the platform selection;
// stubbing it keeps the highlight and the restore paths under test even though
// jsdom ships no selection implementation.
function mockRangeSelection(range: Range | null, text = "") {
  const added: Range[] = [];
  const removeAllRanges = vi.fn();
  vi.spyOn(window, "getSelection").mockReturnValue({
    addRange: (addedRange: Range) => {
      added.push(addedRange);
    },
    anchorNode: range?.startContainer ?? null,
    getRangeAt: () => range,
    isCollapsed: range ? range.collapsed : true,
    rangeCount: range ? 1 : 0,
    removeAllRanges,
    toString: () => text,
  } as unknown as Selection);

  return { added, removeAllRanges };
}

function createTextRange(node: Text, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

afterEach(() => {
  Reflect.deleteProperty(document, "caretRangeFromPoint");
});

describe("InspectorKeyValueTable", () => {
  afterEach(() => {
    useAppPreferencesStore.setState({ languagePreference: "en" });
  });

  it("renders the pseudo-header chip label through i18n", () => {
    // Assert against the zh-CN message: a hardcoded English "pseudo" label
    // would not follow the locale switch.
    useAppPreferencesStore.setState({ languagePreference: "zh-CN" });

    renderWithProviders(
      <InspectorKeyValueTable
        items={[
          { name: ":method", value: "GET", isPseudo: true },
          { name: "host", value: "example.com" },
        ]}
      />,
    );

    expect(screen.getByText("伪标头")).toBeInTheDocument();
    expect(screen.queryByText("pseudo")).not.toBeInTheDocument();
  });
});

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

    expect(container.querySelector(`mark[data-match-index="${targetIndex}"]`)).toBeInTheDocument();
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

describe("SearchableCodeBlock JSON token interaction", () => {
  const jsonCode = '{\n  "profile": {\n    "name": "Hello world"\n  }\n}';

  function renderJsonBlock(onSearchWithText?: (text: string) => void) {
    const result = renderWithProviders(
      <SearchableCodeBlock
        code={jsonCode}
        language="json"
        onSearchWithText={onSearchWithText}
        searchQuery=""
      />,
    );

    return { ...result, pre: result.container.querySelector("pre") as HTMLElement };
  }

  it("snaps a double-click to the string value without its quotes", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    const ranges = mockWritableSelection();

    act(() => {
      fireEvent.doubleClick(pre, { clientX: 20, clientY: 20 });
    });

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.toString()).toBe("Hello world");
  });

  it("keeps modified double-clicks with the platform selection", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    const ranges = mockWritableSelection();

    act(() => {
      fireEvent.doubleClick(pre, { altKey: true, clientX: 20, clientY: 20 });
    });

    expect(ranges).toHaveLength(0);
  });

  it("selects the trimmed line on the third click", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    const ranges = mockWritableSelection();

    act(() => {
      fireEvent.click(pre, { clientX: 20, clientY: 20, detail: 3 });
    });

    expect(ranges[0]?.toString()).toBe('"name": "Hello world"');
  });

  it("offers token actions when right-clicking without a selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const onSearchWithText = vi.fn();
    const { pre } = renderJsonBlock(onSearchWithText);
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    mockWritableSelection("");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });

    expect(screen.getByText("Copy Value")).toBeInTheDocument();
    expect(screen.getByText("Copy Path")).toBeInTheDocument();
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByText("Copy Path"));
    });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("$.profile.name");
    });
  });

  it("labels the token action for keys and limits the path to parseable JSON", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, '"name"'), offset: 3 });
    mockWritableSelection("");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });

    expect(screen.getByText("Copy Key")).toBeInTheDocument();
  });

  it("keeps the generic Copy only for selections that differ from the token", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    mockWritableSelection("Hello");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });

    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.getByText("Copy Value")).toBeInTheDocument();
  });

  it("hides the generic Copy when the selection is the snapped token", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    mockWritableSelection("Hello world");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });

    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
    expect(screen.getByText("Copy Value")).toBeInTheDocument();
  });

  it("searches the token under the pointer when nothing is selected", () => {
    const onSearchWithText = vi.fn();
    const { pre } = renderJsonBlock(onSearchWithText);
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    mockWritableSelection("");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });
    act(() => {
      fireEvent.click(screen.getByText("Search"));
    });

    expect(onSearchWithText).toHaveBeenCalledWith("Hello world");
  });

  it("ignores token actions for plain text blocks", () => {
    const { container } = renderWithProviders(
      <SearchableCodeBlock code="hello world" searchQuery="" />,
    );
    const pre = container.querySelector("pre") as HTMLElement;
    mockCaretRangeFromPoint({ node: findTextNode(pre, "hello"), offset: 2 });
    const ranges = mockWritableSelection();

    act(() => {
      fireEvent.doubleClick(pre, { clientX: 20, clientY: 20 });
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });

    expect(ranges).toHaveLength(0);
    expect(screen.queryByText("Copy Value")).not.toBeInTheDocument();
  });

  it("paints the selection itself while the context menu is open", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    // The string token owns its quotes, so the body starts one character in.
    const range = createTextRange(findTextNode(pre, "Hello world"), 2, 8);
    const { removeAllRanges } = mockRangeSelection(range, "ello w");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });

    const highlights = pre.querySelectorAll('[data-selection-highlight="true"]');

    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.textContent).toBe("ello w");
    // The platform selection is dropped so the block paints one highlight only.
    expect(removeAllRanges).toHaveBeenCalled();
  });

  it("outlines the token under the pointer when nothing is selected", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    mockWritableSelection("");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });

    const highlights = pre.querySelectorAll('[data-selection-highlight="true"]');

    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.textContent).toBe("Hello world");
  });

  it("hands the selection back after a copy action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    const range = createTextRange(findTextNode(pre, "Hello world"), 2, 8);
    const { added } = mockRangeSelection(range, "ello w");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });
    act(() => {
      fireEvent.click(screen.getByText("Copy"));
    });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("ello w");
    });
    expect(added.map((item) => item.toString())).toEqual(["ello w"]);
    expect(pre.querySelectorAll('[data-selection-highlight="true"]')).toHaveLength(0);
  });

  it("drops the selection when the menu is dismissed from outside", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    const range = createTextRange(findTextNode(pre, "Hello world"), 2, 8);
    const { added } = mockRangeSelection(range, "ello w");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });
    act(() => {
      fireEvent.click(document.querySelector(".MuiBackdrop-root")!);
    });

    expect(added).toHaveLength(0);
    expect(pre.querySelectorAll('[data-selection-highlight="true"]')).toHaveLength(0);
  });

  it("hands the selection back on escape", () => {
    const { pre } = renderJsonBlock();
    mockCaretRangeFromPoint({ node: findTextNode(pre, "Hello world"), offset: 3 });
    const range = createTextRange(findTextNode(pre, "Hello world"), 2, 8);
    const { added } = mockRangeSelection(range, "ello w");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });
    act(() => {
      fireEvent.keyDown(document.querySelector(".MuiModal-root")!, { key: "Escape" });
    });

    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
    expect(added.map((item) => item.toString())).toEqual(["ello w"]);
  });

  it("keeps the selection painted for plain text blocks", () => {
    const { container } = renderWithProviders(
      <SearchableCodeBlock code="hello world" searchQuery="" />,
    );
    const pre = container.querySelector("pre") as HTMLElement;
    const range = createTextRange(findTextNode(pre, "hello world"), 0, 5);
    mockRangeSelection(range, "hello");

    act(() => {
      fireEvent.contextMenu(pre, { clientX: 20, clientY: 20 });
    });

    const highlights = pre.querySelectorAll('[data-selection-highlight="true"]');

    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.textContent).toBe("hello");
  });

  it("clips the highlight to the virtualized lines that are rendered", () => {
    const code = `{\n${Array.from(
      { length: 400 },
      (_value, index) => `  "key${index}": "value${index}"`,
    ).join(",\n")}\n}`;
    const { container } = renderWithProviders(
      <SearchableCodeBlock code={code} language="json" searchQuery="" />,
    );
    const virtualContainer = container.firstChild as HTMLElement;
    const range = createTextRange(findTextNode(virtualContainer, '"key1"'), 1, 5);
    mockRangeSelection(range, "key1");

    act(() => {
      fireEvent.contextMenu(virtualContainer, { clientX: 20, clientY: 20 });
    });

    const highlights = virtualContainer.querySelectorAll('[data-selection-highlight="true"]');

    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.textContent).toBe("key1");
  });

  it("maps pointer positions onto virtualized lines", () => {
    const code = `{\n${Array.from(
      { length: 400 },
      (_value, index) => `  "key${index}": "value${index}"`,
    ).join(",\n")}\n}`;
    const { container } = renderWithProviders(
      <SearchableCodeBlock code={code} language="json" searchQuery="" />,
    );
    const virtualContainer = container.firstChild as HTMLElement;
    const keyNode = findTextNode(virtualContainer, '"key1"');
    mockCaretRangeFromPoint({ node: keyNode, offset: 3 });
    const ranges = mockWritableSelection();

    act(() => {
      fireEvent.doubleClick(virtualContainer, { clientX: 20, clientY: 20 });
    });

    expect(ranges[0]?.toString()).toBe("key1");
  });
});
