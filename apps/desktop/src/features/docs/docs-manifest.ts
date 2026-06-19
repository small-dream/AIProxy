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
// have no frontmatter and their H1 carries a "使用指南" suffix unsuited to nav copy.
export const docsEntries: DocsEntry[] = [
  {
    slug: "certificate-setup",
    titleKey: "docsPage.entries.certificateSetup",
    group: "getting-started",
    order: 0,
  },
  {
    slug: "dns-mapping",
    titleKey: "docsPage.entries.dnsMapping",
    group: "capture",
    order: 0,
  },
  {
    slug: "websocket-inspector",
    titleKey: "docsPage.entries.websocketInspector",
    group: "capture",
    order: 1,
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
    slug: "collections-and-environments",
    titleKey: "docsPage.entries.collectionsAndEnvironments",
    group: "advanced",
    order: 0,
  },
];
