import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./runtime", () => ({
  isTauriRuntime: vi.fn(),
  reportCommandFailure: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { setMenuLocale } from "./menu";

describe("setMenuLocale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes set_menu_locale with the preference", async () => {
    await setMenuLocale("zh-CN");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("set_menu_locale", { preference: "zh-CN" });
  });

  it("bypasses invoke in non-Tauri runtime", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);

    await setMenuLocale("en");

    expect(invoke).not.toHaveBeenCalled();
  });

  it("swallows IPC errors (never rejects) so fire-and-forget callers stay safe", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("ipc down"));

    await expect(setMenuLocale("system")).resolves.toBeUndefined();
  });
});
