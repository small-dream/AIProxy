import type {
  BreakpointRule,
  DnsMappingRule,
  MapRule,
  RewriteRule,
  RulesExportFile,
  ScriptRule,
  ThrottleProfile,
  ThrottleRule,
} from "@aiproxy/shared-types";

export type RulesImportCounts = {
  breakpoint: number;
  dns: number;
  map: number;
  rewrite: number;
  script: number;
  throttle: number;
  throttleProfiles: number;
};

export function emptyImportCounts(): RulesImportCounts {
  return {
    breakpoint: 0,
    dns: 0,
    map: 0,
    rewrite: 0,
    script: 0,
    throttle: 0,
    throttleProfiles: 0,
  };
}

export type RulesImportPlan = {
  counts: RulesImportCounts;
  file: RulesExportFile;
};

export function collectRulesForExport(input: {
  breakpoint: BreakpointRule[];
  dns: DnsMappingRule[];
  map: MapRule[];
  rewrite: RewriteRule[];
  script: ScriptRule[];
  throttle: ThrottleRule[];
  throttleProfiles: ThrottleProfile[];
}): RulesExportFile {
  return {
    exportedAt: new Date().toISOString(),
    format: "aiproxy.rules",
    version: 1,
    rules: input,
  };
}

export function planRulesImport(file: RulesExportFile): RulesImportPlan {
  const counts: RulesImportCounts = {
    breakpoint: file.rules.breakpoint.length,
    dns: file.rules.dns.length,
    map: file.rules.map.length,
    rewrite: file.rules.rewrite.length,
    script: file.rules.script.length,
    throttle: file.rules.throttle.length,
    throttleProfiles: file.rules.throttleProfiles.length,
  };
  return { counts, file };
}

type RegenerableRule = {
  enabled: boolean;
  id: string;
  workspaceId: string;
};

/**
 * Imported rules get fresh ids, are disabled by default, and land in the
 * default workspace — they never overwrite existing rules or start applying
 * before the user reviews them (M6).
 */
export function regenerateImportedRules<T extends RegenerableRule>(rules: T[]): T[] {
  return rules.map((rule) => ({
    ...rule,
    enabled: false,
    id: crypto.randomUUID(),
    workspaceId: "default",
  }));
}

/**
 * Breakpoint rules have no workspaceId; they only need fresh ids + disabled.
 */
export function regenerateImportedBreakpointRules(rules: BreakpointRule[]): BreakpointRule[] {
  return rules.map((rule) => ({
    ...rule,
    enabled: false,
    id: crypto.randomUUID(),
  }));
}

/**
 * Throttle profiles keep their ids (throttle rules reference them by id) but
 * are disabled; only missing profile ids are added, so a re-import of an
 * exported file does not duplicate existing profiles.
 */
export function regenerateImportedProfiles(
  profiles: ThrottleProfile[],
  existing: ThrottleProfile[],
): ThrottleProfile[] {
  const existingIds = new Set(existing.map((profile) => profile.id));
  return profiles
    .filter((profile) => !existingIds.has(profile.id))
    .map((profile) => ({
      ...profile,
      enabled: false,
      workspaceId: "default",
    }));
}
