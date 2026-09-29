import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MatchTypeSelect } from "./MatchTypeSelect";

// Keep the test free of the i18n provider dependency.
vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("MatchTypeSelect", () => {
  it("labels the select with its caption so it is reachable by name", () => {
    render(<MatchTypeSelect value="contains" onChange={vi.fn()} />);

    expect(
      screen.getByRole("combobox", { name: "rulesPage.editor.matchType" }),
    ).toBeInTheDocument();
  });

  it("gives every instance its own label id", () => {
    render(
      <>
        <MatchTypeSelect value="contains" onChange={vi.fn()} />
        <MatchTypeSelect value="exact" onChange={vi.fn()} />
      </>,
    );

    const captions = screen.getAllByText("rulesPage.editor.matchType");
    expect(captions).toHaveLength(2);
    expect(captions[0]?.id).not.toBe("");
    expect(captions[0]?.id).not.toBe(captions[1]?.id);
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });
});
