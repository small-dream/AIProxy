import { fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { describe, expect, it, vi } from "vitest";

import { MarkdownRenderer } from "./MarkdownRenderer";

function renderMd(md: string) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <MarkdownRenderer allowHtml>{md}</MarkdownRenderer>
    </ThemeProvider>,
  );
}

describe("MarkdownRenderer", () => {
  it("renders inlined HTML anchors as invisible anchors, not literal markup", () => {
    // Mirrors certificate-setup.md's "### <a id=\"...\"></a>标题" pattern.
    renderMd('### <a id="port-in-use"></a>代理端口被占用');

    const heading = screen.getByRole("heading", { level: 3 });
    // Heading copy stays intact...
    expect(heading).toHaveTextContent("代理端口被占用");
    // ...and the raw <a> markup must not leak as visible text.
    expect(heading).not.toHaveTextContent("<a");
    // The anchor id is preserved so it can serve as a deep-link target.
    expect(document.getElementById("port-in-use")).not.toBeNull();
  });

  it("scrolls to in-page anchors instead of opening a new tab", () => {
    renderMd('See [port](#port-in-use).\n\n<a id="port-in-use"></a>');
    const link = screen.getByRole("link", { name: "port" });
    // Must not be a new-tab link (which would clobber the hash under HashRouter).
    expect(link).not.toHaveAttribute("target", "_blank");

    const scrollIntoViewMock = vi.spyOn(Element.prototype, "scrollIntoView");
    fireEvent.click(link);
    expect(scrollIntoViewMock).toHaveBeenCalled();
    scrollIntoViewMock.mockRestore();
  });
});
