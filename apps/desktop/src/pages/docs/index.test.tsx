import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { DocsPage } from "@/pages/docs";

const openUrlMock = vi.fn();

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

vi.mock("@/services/commands", () => ({
  setMenuLocale: () => Promise.resolve(),
}));

function renderDocsAt(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppProviders>
        <DocsPage />
      </AppProviders>
    </MemoryRouter>,
  );
}

function articleHeading() {
  return screen.getByRole("heading", { level: 1 });
}

describe("DocsPage", () => {
  beforeEach(() => {
    openUrlMock.mockReset();
  });

  it("renders the guide named in the ?doc= search param", async () => {
    renderDocsAt("/docs?doc=rewrite-rules");

    await waitFor(() => {
      // rewrite-rules.md H1 is "Rewrite 改写规则使用指南".
      expect(articleHeading()).toHaveTextContent("Rewrite");
    });
  });

  it("falls back to the first guide when the slug is unknown", async () => {
    renderDocsAt("/docs?doc=does-not-exist");

    await waitFor(() => {
      // certificate-setup is the first manifest entry; its H1 mentions 证书安装.
      expect(articleHeading()).toHaveTextContent("证书安装");
    });
  });

  it("switches guides from the sidebar table of contents", async () => {
    renderDocsAt("/docs?doc=rewrite-rules");
    await waitFor(() => expect(articleHeading()).toHaveTextContent("Rewrite"));

    // Entry titles come from docsPage.entries.* (en by default in jsdom); match both
    // locales so the assertion is stable regardless of the resolved language.
    const collectionsEntry = screen.getByRole("button", {
      name: /集合|Collections/i,
    });
    fireEvent.click(collectionsEntry);

    await waitFor(() => {
      // collections-and-environments.md H1 is "API 集合与环境变量使用指南".
      expect(articleHeading()).toHaveTextContent("环境变量");
    });
  });

  it("navigates between guides via in-document markdown links", async () => {
    renderDocsAt("/docs?doc=script-rules-examples");
    await waitFor(() => expect(articleHeading()).toHaveTextContent("示例集"));

    // script-rules-examples.md references ./script-rules.md; the fixed relative link
    // should switch to that guide in-app rather than opening a browser.
    const internalLink = screen.getByRole("link", { name: /script-rules\.md/i });
    fireEvent.click(internalLink);

    await waitFor(() => {
      // script-rules.md H1 is "TypeScript / JavaScript 脚本规则使用指南".
      expect(articleHeading()).toHaveTextContent("TypeScript");
    });
    expect(openUrlMock).not.toHaveBeenCalled();
  });
});
