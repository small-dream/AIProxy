import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThrottleParameter } from "./ProfileEditor";

// ProfileEditor is fully prop-driven (no i18n provider needed), so the numeric
// input behaviour can be exercised through the extracted ThrottleParameter.
describe("ThrottleParameter numeric input (L8)", () => {
  it("keeps the field empty while the user clears it instead of collapsing to 0", () => {
    const onChange = vi.fn();
    render(
      <ThrottleParameter
        icon={null}
        label="Latency"
        max={2000}
        min={0}
        onChange={onChange}
        step={10}
        unit="ms"
        value={100}
      />,
    );

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    // Simulate clearing: user deletes all digits. Before the fix the controlled
    // value collapsed to 0 immediately and onChange fired with 0.
    fireEvent.change(input, { target: { value: "" } });

    expect(input.value).toBe("");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clamps back to the minimum on blur when the field is left empty", () => {
    const onChange = vi.fn();
    render(
      <ThrottleParameter
        icon={null}
        label="Download"
        max={100000}
        min={1}
        onChange={onChange}
        step={100}
        unit="kbps"
        value={500}
      />,
    );

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(1);
    expect(input.value).toBe("1");
  });
});
