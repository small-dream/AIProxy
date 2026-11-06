import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppPreferencesStore } from "@/app/store/app-preferences.store";
import { I18nProvider } from "@/i18n";
import { ComposeRequestSection } from "./ComposeRequestSection";

function renderEditor() {
  const onBodyTypeChange = vi.fn();
  render(
    <I18nProvider>
      <ComposeRequestSection
        activeTab="body"
        body=""
        bodyType="none"
        formDataEntries={[]}
        formFiles={[]}
        headers={[]}
        onActiveTabChange={vi.fn()}
        onBodyChange={vi.fn()}
        onBodyTypeChange={onBodyTypeChange}
        onFormDataEntriesChange={vi.fn()}
        onFormFilesChange={vi.fn()}
        onHeadersChange={vi.fn()}
        onRawLanguageChange={vi.fn()}
        onUrlChange={vi.fn()}
        onUrlEncodedEntriesChange={vi.fn()}
        rawLanguage="json"
        url="https://example.com/api"
        urlEncodedEntries={[]}
      />
    </I18nProvider>,
  );
  return { onBodyTypeChange };
}

beforeEach(() => useAppPreferencesStore.getState().setLanguagePreference("zh-CN"));
afterEach(() => useAppPreferencesStore.getState().setLanguagePreference("system"));

describe("request editor localization", () => {
  it("uses Chinese labels and preserves the body type selection behavior", () => {
    const { onBodyTypeChange } = renderEditor();
    for (const name of ["请求头", "请求体", "查询参数"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("此请求不发送请求体。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "无" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "多部分表单" }));
    expect(onBodyTypeChange).toHaveBeenCalledWith("formdata");
    fireEvent.click(screen.getByRole("button", { name: "URL 编码表单" }));
    expect(onBodyTypeChange).toHaveBeenCalledWith("urlencoded");
    fireEvent.click(screen.getByRole("button", { name: "原始内容" }));
    expect(onBodyTypeChange).toHaveBeenCalledWith("raw");
  });

  it("exposes the original MIME type in a tooltip without changing the button name", async () => {
    renderEditor();
    fireEvent.mouseOver(screen.getByRole("button", { name: "多部分表单" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("multipart/form-data");
    expect(screen.getByRole("button", { name: "多部分表单" })).toBeInTheDocument();
  });

  it("updates the same editor when switching to English", () => {
    renderEditor();
    act(() => useAppPreferencesStore.getState().setLanguagePreference("en"));
    expect(screen.getByRole("tab", { name: "Headers" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Body" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "form-data" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "请求体" })).not.toBeInTheDocument();
  });
});
