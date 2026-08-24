import type { AndroidAdbDevice } from "@aiproxy/shared-types";

/**
 * Human-readable ADB device label shown in device pickers (quick-action
 * panel and the multi-device picker dialog). Uses the friendliest identifier
 * available, then falls back to the serial.
 */
export function formatAdbDeviceLabel(
  device: Pick<AndroidAdbDevice, "serial" | "state" | "model" | "product" | "device">,
): string {
  const primaryLabel = device.model ?? device.product ?? device.device ?? device.serial;
  return `${primaryLabel} (${device.serial}) - ${device.state}`;
}
