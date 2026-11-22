import {
  coerceAppError,
  parseRulesExportFile,
  UNSUPPORTED_RULES_VERSION_CODE,
  type RulesExportFile,
} from "@aiproxy/shared-types";
import { describe, expect, it } from "vitest";

import {
  collectRulesForExport,
  planRulesImport,
  regenerateImportedBreakpointRules,
  regenerateImportedProfiles,
  regenerateImportedRules,
} from "./rules-import-export.helpers";

function sampleExport(overrides: Partial<RulesExportFile> = {}): RulesExportFile {
  return {
    exportedAt: "2026-08-18T00:00:00.000Z",
    format: "aiproxy.rules",
    version: 1,
    rules: {
      breakpoint: [],
      dns: [],
      map: [
        {
          id: "m1",
          workspaceId: "default",
          mode: "remote",
          name: "Map",
          enabled: true,
          priority: 100,
          sourcePattern: "example.com",
          targetValue: "https://staging.example.com",
          preservePath: true,
          preserveQuery: true,
          note: "",
        },
      ],
      rewrite: [],
      script: [],
      throttle: [],
      throttleProfiles: [
        {
          id: "p1",
          workspaceId: "default",
          name: "Slow",
          enabled: true,
          preset: false,
          latencyMs: 100,
          uploadKbps: 300,
          downloadKbps: 500,
          packetLossRatio: 0,
          note: "",
        },
      ],
    },
    ...overrides,
  };
}

describe("parseRulesExportFile", () => {
  it("accepts a well-formed export", () => {
    expect(() => parseRulesExportFile(sampleExport())).not.toThrow();
  });

  it("rejects a wrong format", () => {
    expect(() =>
      parseRulesExportFile(sampleExport({ format: "other" as "aiproxy.rules" })),
    ).toThrow();
  });

  it("rejects an unsupported version", () => {
    expect(() => parseRulesExportFile(sampleExport({ version: 99 as 1 }))).toThrow();
  });

  // N-3: a recognized aiproxy.rules file with an unsupported version must
  // carry the structured code so the import UI can show version-specific
  // guidance; every other malformed input keeps the generic error.
  it("classifies an unsupported version with a structured error code (N-3)", () => {
    let thrown: unknown;
    try {
      parseRulesExportFile(sampleExport({ version: 99 as 1 }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const appError = coerceAppError(thrown);
    expect(appError.code).toBe(UNSUPPORTED_RULES_VERSION_CODE);
    expect(appError.details).toMatchObject({ version: 99 });
  });

  it("keeps the generic error for a wrong format (N-3)", () => {
    let thrown: unknown;
    try {
      parseRulesExportFile(sampleExport({ format: "other" as "aiproxy.rules" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(coerceAppError(thrown).code).not.toBe(UNSUPPORTED_RULES_VERSION_CODE);
  });
});

describe("collectRulesForExport / planRulesImport", () => {
  it("round-trips counts for each rule kind", () => {
    const file = collectRulesForExport({
      breakpoint: [],
      dns: [],
      map: [],
      rewrite: [],
      script: [],
      throttle: [],
      throttleProfiles: [],
    });
    expect(file.format).toBe("aiproxy.rules");
    expect(file.version).toBe(1);

    const plan = planRulesImport(sampleExport());
    expect(plan.counts.map).toBe(1);
    expect(plan.counts.throttleProfiles).toBe(1);
    expect(plan.counts.rewrite).toBe(0);
  });
});

describe("regenerateImportedRules", () => {
  it("replaces ids, disables rules, and pins the default workspace", () => {
    const [rule] = regenerateImportedRules(sampleExport().rules.map);
    expect(rule).toBeDefined();
    expect(rule!.id).not.toBe("m1");
    expect(rule!.enabled).toBe(false);
    expect(rule!.workspaceId).toBe("default");
  });
});

describe("regenerateImportedBreakpointRules", () => {
  it("replaces ids and disables breakpoint rules without a workspace", () => {
    const [rule] = regenerateImportedBreakpointRules([
      { id: "b1", enabled: true, urlPattern: "*", methods: [], stage: "request" },
    ]);
    expect(rule!.id).not.toBe("b1");
    expect(rule!.enabled).toBe(false);
    expect(rule!.urlPattern).toBe("*");
  });
});

describe("regenerateImportedProfiles", () => {
  it("keeps profile ids and only adds missing ones", () => {
    const existing = [
      {
        id: "p1",
        workspaceId: "default",
        name: "Slow",
        enabled: true,
        preset: false,
        latencyMs: 100,
        uploadKbps: 300,
        downloadKbps: 500,
        packetLossRatio: 0,
        note: "",
      },
    ];
    const extra = {
      id: "p2",
      workspaceId: "default",
      name: "Fast",
      enabled: true,
      preset: false,
      latencyMs: 0,
      uploadKbps: 10000,
      downloadKbps: 20000,
      packetLossRatio: 0,
      note: "",
    };

    const added = regenerateImportedProfiles([existing[0]!, extra], existing);
    expect(added).toHaveLength(1);
    expect(added[0]!.id).toBe("p2");
    expect(added[0]!.enabled).toBe(false);
    expect(added[0]!.workspaceId).toBe("default");
  });
});
