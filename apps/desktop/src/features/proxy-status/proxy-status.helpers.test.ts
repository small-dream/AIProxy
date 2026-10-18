import { describe, expect, it } from "vitest";
import { createDefaultProxyStatus } from "@aiproxy/shared-types";

import { enMessages } from "@/i18n/messages/en";
import { formatRecordingDuration, getProxyStatusPresentation } from "./proxy-status.helpers";

describe("getProxyStatusPresentation", () => {
  it("returns a loading label when the status is not yet available", () => {
    const actual = getProxyStatusPresentation(undefined);

    expect(actual).toEqual({
      chipColor: "default",
      label: "Proxy Loading",
    });
  });

  it("returns a running label when the proxy is active", () => {
    const actual = getProxyStatusPresentation({
      ...createDefaultProxyStatus(),
      port: 9999,
      running: true,
    });

    expect(actual).toEqual({
      chipColor: "success",
      label: "Proxy Running :9999",
    });
  });

  it("replaces EVERY {{port}} placeholder when a message contains the token multiple times (L11)", () => {
    // A localization that repeats the port token exposes the old
    // String.replace() bug, which only swapped the first match.
    const messages = {
      idleWithPort: "Idle {{port}} / {{port}}",
      readyWithPort: "Ready {{port}} / {{port}}",
      runningWithPort: "Running {{port}} / {{port}}",
      loading: "Proxy Loading",
    } as unknown as typeof enMessages.proxyStatus;

    const running = getProxyStatusPresentation(
      { ...createDefaultProxyStatus(), port: 8080, running: true },
      messages,
    );
    const ready = getProxyStatusPresentation(
      { ...createDefaultProxyStatus(), port: 8080, running: false, sslEnabled: true },
      messages,
    );
    const idle = getProxyStatusPresentation(
      { ...createDefaultProxyStatus(), port: 8080, running: false, sslEnabled: false },
      messages,
    );

    expect(running.label).toBe("Running 8080 / 8080");
    expect(ready.label).toBe("Ready 8080 / 8080");
    expect(idle.label).toBe("Idle 8080 / 8080");
  });
});

describe("formatRecordingDuration", () => {
  it("formats sub-hour durations as m:ss", () => {
    expect(formatRecordingDuration(0)).toBe("0:00");
    expect(formatRecordingDuration(59_000)).toBe("0:59");
    expect(formatRecordingDuration(3_500)).toBe("0:03");
    expect(formatRecordingDuration(222_000)).toBe("3:42");
    expect(formatRecordingDuration(3_599_000)).toBe("59:59");
  });

  it("formats hour-long durations as h:mm:ss", () => {
    expect(formatRecordingDuration(3_600_000)).toBe("1:00:00");
    expect(formatRecordingDuration(3_661_000)).toBe("1:01:01");
    expect(formatRecordingDuration(36_000_000)).toBe("10:00:00");
  });

  it("clamps negative and non-finite input to 0:00", () => {
    expect(formatRecordingDuration(-5_000)).toBe("0:00");
    expect(formatRecordingDuration(Number.NaN)).toBe("0:00");
  });
});
