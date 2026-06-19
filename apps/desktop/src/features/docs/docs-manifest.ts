import type { TranslationKey } from "@/i18n";

// User-guide groups shown in the table of contents, in display order.
export type DocsGroup = "getting-started" | "capture" | "rules" | "advanced";

export interface DocsEntry {
  // Filename without extension; also the ?doc= value and the glob lookup key.
  slug: string;
  // i18n key for the title shown in the table of contents.
  titleKey: TranslationKey;
  // Cluster used to group entries in the table of contents.
  group: DocsGroup;
  // Sort order within the group (ascending).
  order: number;
}

export const docsGroupOrder: DocsGroup[] = [
  "getting-started",
  "capture",
  "rules",
  "advanced",
];

export const docsGroupTitleKey: Record<DocsGroup, TranslationKey> = {
  "getting-started": "docsPage.groups.gettingStarted",
  capture: "docsPage.groups.capture",
  rules: "docsPage.groups.rules",
  advanced: "docsPage.groups.advanced",
};

// Titles/groups are maintained here (not parsed from markdown) because the guides
// have no frontmatter and their H1 is a prose title unsuited to compact nav copy.
// Article bodies live in user-guides/{en,zh-CN}/<slug>.md and are selected by locale
// in docs-content.ts; slugs here must match a file in both locales (parity-enforced).
export const docsEntries: DocsEntry[] = [
  {
    slug: "certificate-setup",
    titleKey: "docsPage.entries.certificateSetup",
    group: "getting-started",
    order: 0,
  },
  {
    slug: "sessions",
    titleKey: "docsPage.entries.sessions",
    group: "capture",
    order: 0,
  },
  {
    slug: "dns-mapping",
    titleKey: "docsPage.entries.dnsMapping",
    group: "capture",
    order: 1,
  },
  {
    slug: "websocket-inspector",
    titleKey: "docsPage.entries.websocketInspector",
    group: "capture",
    order: 2,
  },
  {
    slug: "rewrite-rules",
    titleKey: "docsPage.entries.rewriteRules",
    group: "rules",
    order: 0,
  },
  {
    slug: "script-rules",
    titleKey: "docsPage.entries.scriptRules",
    group: "rules",
    order: 1,
  },
  {
    slug: "script-rules-examples",
    titleKey: "docsPage.entries.scriptRulesExamples",
    group: "rules",
    order: 2,
  },
  {
    slug: "throttling",
    titleKey: "docsPage.entries.throttling",
    group: "rules",
    order: 3,
  },
  {
    slug: "breakpoints",
    titleKey: "docsPage.entries.breakpoints",
    group: "rules",
    order: 4,
  },
  {
    slug: "map-rules",
    titleKey: "docsPage.entries.mapRules",
    group: "rules",
    order: 5,
  },
  {
    slug: "collections-and-environments",
    titleKey: "docsPage.entries.collectionsAndEnvironments",
    group: "advanced",
    order: 0,
  },
  {
    slug: "compose",
    titleKey: "docsPage.entries.compose",
    group: "advanced",
    order: 1,
  },
  {
    slug: "insights",
    titleKey: "docsPage.entries.insights",
    group: "advanced",
    order: 2,
  },
  {
    slug: "session-compare",
    titleKey: "docsPage.entries.sessionCompare",
    group: "advanced",
    order: 3,
  },
  {
    slug: "settings",
    titleKey: "docsPage.entries.settings",
    group: "advanced",
    order: 4,
  },
];
