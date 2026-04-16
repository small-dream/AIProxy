import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SearchableCodeBlock } from "./SessionInspectorShared";

function createLargeCodeBlock() {
  return Array.from({ length: 400 }, (_value, index) => `line ${index} match`).join("\n");
}

describe("SearchableCodeBlock", () => {
  it("virtualizes large content when search is inactive", () => {
    const { container } = render(<SearchableCodeBlock code={createLargeCodeBlock()} searchQuery="" />);

    expect(container).not.toHaveTextContent("line 399 match");
  });

  it("keeps large content virtualized while scrolling to the first matching off-screen line", () => {
    const { container } = render(<SearchableCodeBlock code={createLargeCodeBlock()} searchQuery="line 399" />);
    const scrollContainer = container.firstChild as HTMLDivElement | null;

    expect(container).toHaveTextContent("line 399");
    expect(scrollContainer?.scrollTop ?? 0).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent("line 0 match");
  });
});
