import { describe, expect, it } from "vitest";

import { buildTimingSegments, getTimingPhaseColor } from "./WaterfallChart";
import type { TimingPhaseId } from "./WaterfallChart";

const ALL_PHASES: TimingPhaseId[] = ["dns", "connect", "tls", "send", "wait", "download"];

describe("buildTimingSegments", () => {
  it("scales measured phases against the reported total", () => {
    const segments = buildTimingSegments({
      mode: "light",
      timing: { dnsMs: 10, responseReadMs: 30, totalMs: 100, waitingMs: 60 },
    });

    expect(segments.map((segment) => segment.id)).toEqual(["dns", "wait", "download"]);
    expect(segments.map((segment) => Math.round(segment.percent))).toEqual([10, 60, 30]);
    expect(segments.map((segment) => segment.valueMs)).toEqual([10, 60, 30]);
  });

  it("keeps the timeline order no matter how the timing fields arrive", () => {
    const segments = buildTimingSegments({
      mode: "light",
      timing: {
        connectMs: 1,
        dnsMs: 1,
        requestSendMs: 1,
        responseReadMs: 1,
        tlsMs: 1,
        waitingMs: 1,
      },
    });

    expect(segments.map((segment) => segment.id)).toEqual(ALL_PHASES);
  });

  it("drops unmeasured phases instead of drawing placeholder slivers", () => {
    const segments = buildTimingSegments({
      mode: "light",
      timing: { totalMs: 100, waitingMs: 100 },
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]?.id).toBe("wait");
    expect(segments[0]?.percent).toBe(100);
  });

  it("falls back to the summed phases when no total is reported", () => {
    const segments = buildTimingSegments({
      mode: "light",
      timing: { connectMs: 75, dnsMs: 25 },
    });

    expect(segments.map((segment) => segment.percent)).toEqual([25, 75]);
  });

  it("returns no segments when nothing was measured", () => {
    expect(buildTimingSegments({ mode: "light", timing: undefined })).toEqual([]);

    // A total without any phase breakdown has nothing to draw either; the
    // chart falls back to a single neutral band.
    expect(buildTimingSegments({ mode: "light", timing: { totalMs: 120 } })).toEqual([]);
    expect(buildTimingSegments({ mode: "light", timing: { totalMs: 0 } })).toEqual([]);
  });

  it("maps every phase to a distinct color per color mode", () => {
    const lightColors = ALL_PHASES.map((phase) => getTimingPhaseColor(phase, "light"));
    const darkColors = ALL_PHASES.map((phase) => getTimingPhaseColor(phase, "dark"));

    expect(new Set(lightColors).size).toBe(ALL_PHASES.length);
    expect(new Set(darkColors).size).toBe(ALL_PHASES.length);

    for (const phase of ALL_PHASES) {
      expect(getTimingPhaseColor(phase, "dark")).not.toBe(getTimingPhaseColor(phase, "light"));
    }
  });
});
