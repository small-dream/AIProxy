import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { AndroidAdbDevicePickerDialog } from "./AndroidAdbDevicePickerDialog";

// Partial mock: AppProviders (via the i18n provider) also imports from this
// module, so only stub the device probe and keep every other export real.
vi.mock(import("@/services/commands"), async (importOriginal) => ({
  ...(await importOriginal()),
  listAndroidAdbDevices: vi.fn(),
}));

import { listAndroidAdbDevices } from "@/services/commands";

const listDevicesMock = vi.mocked(listAndroidAdbDevices);

function renderPicker(overrides: Partial<Parameters<typeof AndroidAdbDevicePickerDialog>[0]> = {}) {
  const props = {
    open: true,
    action: "set" as const,
    pending: false,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <AppProviders>
      <AndroidAdbDevicePickerDialog {...props} />
    </AppProviders>,
  );
  return { ...utils, props };
}

describe("AndroidAdbDevicePickerDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirms with the first ready device by default", async () => {
    listDevicesMock.mockResolvedValue([
      { serial: "emulator-5554", state: "offline" },
      { serial: "R58M2", state: "device", model: "Pixel 8" },
    ]);
    const { props } = renderPicker();

    const confirm = screen.getByRole("button", { name: "Confirm" });
    // Disabled while the device probe is in flight, enabled once a ready
    // target is auto-selected.
    await waitFor(() => expect(confirm).toBeEnabled());

    fireEvent.click(confirm);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).toHaveBeenCalledWith("R58M2");
  });

  it("keeps confirm disabled and hints at the state when no device is ready", async () => {
    listDevicesMock.mockResolvedValue([{ serial: "emulator-5554", state: "offline" }]);
    renderPicker();

    await waitFor(() => expect(listDevicesMock).toHaveResolved());
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/The selected target is in offline state/)).toBeInTheDocument();
  });
});
