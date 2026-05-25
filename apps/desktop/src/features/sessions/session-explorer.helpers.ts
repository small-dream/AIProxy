import type { SessionSummary } from "@aiproxy/shared-types";

import { enMessages } from "@/i18n/messages/en";
import { isWebSocketSessionProtocol } from "./session-protocol.helpers";

export type SessionExplorerResourceKind =
  | "api"
  | "css"
  | "file"
  | "html"
  | "image"
  | "javascript"
  | "pending"
  | "request"
  | "text"
  | "warning"
  | "websocket";

export type SessionPathLeaf = {
  kind: "leaf";
  searchText: string;
  segmentLabel: string;
  session: SessionSummary;
};

export type SessionPathBranch = {
  branchType: "host" | "path";
  children: SessionPathNode[];
  host?: string;
  kind: "branch";
  pathKey: string;
  searchText: string;
  segmentLabel: string;
};

export type SessionPathNode = SessionPathLeaf | SessionPathBranch;

export type SessionHostGroup = {
  host: string | null;
  isFocused: boolean;
  key: string;
  kind: "aggregate" | "host";
  label: string;
  latestStartedAt: string;
  searchText: string;
  sessions: SessionSummary[];
  totalCount: number;
  tree: SessionPathNode[];
};

type BuildSessionHostGroupsOptions = {
  focusedHosts?: Iterable<string>;
  unfocusedLabel?: string;
};

type MutablePathBranch = {
  children: Map<string, MutablePathBranch>;
  leaves: SessionSummary[];
  pathKey: string;
  segmentLabel: string;
};

export function buildSessionHostGroups(
  sessions: SessionSummary[],
  keyword: string,
  options: BuildSessionHostGroupsOptions & { unknownHostLabel?: string } = {},
): SessionHostGroup[] {
  const groupsByHost = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    if (!matchesKeyword(session, keyword)) {
      continue;
    }

    const host = normalizeHost(session.host, options.unknownHostLabel);
    const existingGroup = groupsByHost.get(host) ?? [];

    existingGroup.push(session);
    groupsByHost.set(host, existingGroup);
  }

  const normalizedFocusedHosts = normalizeOptionalHosts(options.focusedHosts);
  const hostGroups = Array.from(groupsByHost.entries()).map(([host, groupedSessions]) =>
    createHostGroup(host, groupedSessions, normalizedFocusedHosts.has(host)),
  );

  if (normalizedFocusedHosts.size === 0) {
    return hostGroups;
  }

  const focusedGroups = hostGroups.filter(
    (group) => group.host !== null && normalizedFocusedHosts.has(group.host),
  );

  if (focusedGroups.length === 0) {
    return hostGroups;
  }

  const unfocusedGroups = hostGroups.filter(
    (group) => group.host === null || !normalizedFocusedHosts.has(group.host),
  );

  if (unfocusedGroups.length === 0) {
    return focusedGroups;
  }

  return [
    ...focusedGroups,
    createAggregateGroup(unfocusedGroups, options.unfocusedLabel ?? "Unfocused"),
  ];
}

export function filterSessionsByHostKeyword(
  sessions: SessionSummary[],
  hostKeyword: string,
): SessionSummary[] {
  const normalizedKeyword = hostKeyword.trim().toLowerCase();

  if (normalizedKeyword.length === 0) {
    return sessions;
  }

  return sessions.filter((session) => normalizeHost(session.host).toLowerCase().includes(normalizedKeyword));
}

export function reconcileExpandedKeys(
  expandedKeys: string[],
  groups: SessionHostGroup[],
): string[] {
  const availableKeys = new Set<string>();
  const expansionAliases = new Map<string, string[]>();

  for (const group of groups) {
    availableKeys.add(group.key);
    collectBranchKeys(group.tree, group.key, availableKeys);
    collectExpansionAliases(group, expansionAliases);
  }

  const reconciledKeys: string[] = [];
  const seenKeys = new Set<string>();

  for (const key of expandedKeys) {
    appendExpandedKey(key, availableKeys, reconciledKeys, seenKeys);

    const aliases = expansionAliases.get(key) ?? [];

    for (const alias of aliases) {
      appendExpandedKey(alias, availableKeys, reconciledKeys, seenKeys);
    }
  }

  return reconciledKeys;
}

export function getSessionLeafLabel(session: SessionSummary): string {
  const { pathname } = splitSessionPath(session.path);
  const segments = pathnameSegments(pathname);
  const lastSegment = segments.at(-1);

  if (!lastSegment || lastSegment.length === 0) {
    return "/";
  }

  return lastSegment;
}

export function getSessionQuerySuffix(session: SessionSummary): string {
  return splitSessionPath(session.path).search;
}

export function getSessionResourceKind(session: SessionSummary): SessionExplorerResourceKind {
  if (session.statusCode <= 0) {
    return "pending";
  }

  if (session.statusCode >= 400) {
    return "warning";
  }

  if (session.statusCode === 101 || isWebSocketSessionProtocol(session)) {
    return "websocket";
  }

  const mimeType = session.responseMimeType?.toLowerCase() ?? "";
  const leafLabel = getSessionLeafLabel(session).toLowerCase();

  if (mimeType.includes("json") || leafLabel.endsWith(".json")) {
    return "api";
  }

  if (mimeType.includes("javascript") || mimeType.includes("ecmascript") || leafLabel.endsWith(".js") || leafLabel.endsWith(".mjs") || leafLabel.endsWith(".cjs")) {
    return "javascript";
  }

  if (mimeType.includes("css") || leafLabel.endsWith(".css")) {
    return "css";
  }

  if (mimeType.includes("html") || leafLabel.endsWith(".html") || leafLabel.endsWith(".htm")) {
    return "html";
  }

  if (mimeType.startsWith("image/") || /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|\.ico|\.bmp|\.avif)$/.test(leafLabel)) {
    return "image";
  }

  if (mimeType.startsWith("text/") || mimeType.includes("xml") || mimeType.includes("plain") || leafLabel.endsWith(".txt") || leafLabel.endsWith(".xml")) {
    return "text";
  }

  if (pathnameLooksLikeDirectory(session.path)) {
    return "request";
  }

  return "file";
}

function collectBranchKeys(nodes: SessionPathNode[], parentKey: string, availableKeys: Set<string>) {
  for (const node of nodes) {
    if (node.kind !== "branch") {
      continue;
    }

    const key = `${parentKey}::${node.pathKey}`;
    availableKeys.add(key);
    collectBranchKeys(node.children, parentKey, availableKeys);
  }
}

function appendExpandedKey(
  key: string,
  availableKeys: Set<string>,
  reconciledKeys: string[],
  seenKeys: Set<string>,
) {
  if (!availableKeys.has(key) || seenKeys.has(key)) {
    return;
  }

  seenKeys.add(key);
  reconciledKeys.push(key);
}

function collectExpansionAliases(group: SessionHostGroup, aliases: Map<string, string[]>) {
  if (group.kind === "aggregate") {
    collectAggregateExpansionAliases(group, aliases);
    return;
  }

  collectStandaloneHostExpansionAliases(group, aliases);
}

function collectAggregateExpansionAliases(group: SessionHostGroup, aliases: Map<string, string[]>) {
  for (const node of group.tree) {
    if (node.kind !== "branch" || node.branchType !== "host" || !node.host) {
      continue;
    }

    const aggregateHostKey = `${group.key}::${node.pathKey}`;

    addExpansionAlias(aliases, node.host, [group.key, aggregateHostKey]);
    collectAggregateBranchExpansionAliases({
      aggregateGroupKey: group.key,
      aggregateHostKey,
      aliases,
      host: node.host,
      hostPathPrefix: node.pathKey,
      nodes: node.children,
    });
  }
}

function collectAggregateBranchExpansionAliases({
  aggregateGroupKey,
  aggregateHostKey,
  aliases,
  host,
  hostPathPrefix,
  nodes,
}: {
  aggregateGroupKey: string;
  aggregateHostKey: string;
  aliases: Map<string, string[]>;
  host: string;
  hostPathPrefix: string;
  nodes: SessionPathNode[];
}) {
  for (const node of nodes) {
    if (node.kind !== "branch") {
      continue;
    }

    const legacyPathKey = node.pathKey.startsWith(`${hostPathPrefix}/`)
      ? node.pathKey.slice(hostPathPrefix.length + 1)
      : node.pathKey;
    const aggregateBranchKey = `${aggregateGroupKey}::${node.pathKey}`;

    addExpansionAlias(aliases, `${host}::${legacyPathKey}`, [
      aggregateGroupKey,
      aggregateHostKey,
      aggregateBranchKey,
    ]);
    collectAggregateBranchExpansionAliases({
      aggregateGroupKey,
      aggregateHostKey,
      aliases,
      host,
      hostPathPrefix,
      nodes: node.children,
    });
  }
}

function collectStandaloneHostExpansionAliases(group: SessionHostGroup, aliases: Map<string, string[]>) {
  if (!group.host) {
    return;
  }

  const aggregateHostPathKey = `host:${group.host}`;

  addExpansionAlias(aliases, `__unfocused__::${aggregateHostPathKey}`, [group.key]);
  collectStandaloneBranchExpansionAliases(group.tree, group.host, aggregateHostPathKey, aliases);
}

function collectStandaloneBranchExpansionAliases(
  nodes: SessionPathNode[],
  host: string,
  aggregateHostPathKey: string,
  aliases: Map<string, string[]>,
) {
  for (const node of nodes) {
    if (node.kind !== "branch") {
      continue;
    }

    addExpansionAlias(aliases, `__unfocused__::${aggregateHostPathKey}/${node.pathKey}`, [
      host,
      `${host}::${node.pathKey}`,
    ]);
    collectStandaloneBranchExpansionAliases(node.children, host, aggregateHostPathKey, aliases);
  }
}

function addExpansionAlias(aliases: Map<string, string[]>, key: string, aliasKeys: string[]) {
  const existingAliases = aliases.get(key) ?? [];
  aliases.set(key, [...existingAliases, ...aliasKeys]);
}

function matchesKeyword(session: SessionSummary, keyword: string): boolean {
  const normalizedKeyword = keyword.trim().toLowerCase();

  if (normalizedKeyword.length === 0) {
    return true;
  }

  const haystacks = [
    session.host,
    session.path,
    session.url,
    session.method,
    String(session.statusCode),
    session.responseMimeType ?? "",
    session.httpVersion ?? "",
    session.transportProtocol ?? "",
    session.applicationProtocol ?? "",
  ];

  return haystacks.some((value) => value.toLowerCase().includes(normalizedKeyword));
}

function normalizeHost(host: string, unknownHostLabel?: string): string {
  const normalizedHost = host.trim();

  return normalizedHost.length > 0 ? normalizedHost : (unknownHostLabel ?? enMessages.sessionExplorer.unknownHost);
}

function normalizeOptionalHost(host?: string | null): string | null {
  if (!host) {
    return null;
  }

  const normalizedHost = host.trim();

  return normalizedHost.length > 0 ? normalizedHost : null;
}

function normalizeOptionalHosts(hosts?: Iterable<string>): Set<string> {
  if (!hosts) {
    return new Set();
  }

  const normalizedHosts = new Set<string>();

  for (const host of hosts) {
    const normalizedHost = normalizeOptionalHost(host);

    if (normalizedHost) {
      normalizedHosts.add(normalizedHost);
    }
  }

  return normalizedHosts;
}

function createHostGroup(
  host: string,
  groupedSessions: SessionSummary[],
  isFocused: boolean,
): SessionHostGroup {
  const orderedSessions = [...groupedSessions];

  return {
    host,
    isFocused,
    key: host,
    kind: "host",
    label: host,
    latestStartedAt: orderedSessions.at(-1)?.startedAt ?? "",
    searchText: buildSearchText(host),
    sessions: orderedSessions,
    totalCount: orderedSessions.length,
    tree: buildPathTree(orderedSessions),
  };
}

function createAggregateGroup(groups: SessionHostGroup[], label: string): SessionHostGroup {
  const sessions = groups.flatMap((group) => group.sessions);

  return {
    host: null,
    isFocused: false,
    key: "__unfocused__",
    kind: "aggregate",
    label,
    latestStartedAt: sessions.at(-1)?.startedAt ?? "",
    searchText: buildSearchText(label, ...groups.map((group) => group.label)),
    sessions,
    totalCount: sessions.length,
    tree: buildAggregateTree(groups),
  };
}

function buildPathTree(sessions: SessionSummary[]): SessionPathNode[] {
  const root: MutablePathBranch = {
    children: new Map<string, MutablePathBranch>(),
    leaves: [],
    pathKey: "",
    segmentLabel: "",
  };

  for (const session of sessions) {
    const { pathname, search } = splitSessionPath(session.path);
    const segments = pathnameSegments(pathname);

    if (shouldGroupDirectoryQueryAtPathLevel(segments, pathname, search)) {
      const segment = segments[0]!;
      const existingChild = root.children.get(segment);

      if (existingChild) {
        existingChild.leaves.push(session);
        continue;
      }

      root.children.set(segment, {
        children: new Map<string, MutablePathBranch>(),
        leaves: [session],
        pathKey: segment,
        segmentLabel: segment,
      });
      continue;
    }

    if (segments.length <= 1) {
      root.leaves.push(session);
      continue;
    }

    let currentNode = root;

    segments.slice(0, -1).forEach((segment, index) => {
      const pathKey = segments.slice(0, index + 1).join("/");
      const existingChild = currentNode.children.get(segment);

      if (existingChild) {
        currentNode = existingChild;
        return;
      }

      const childNode: MutablePathBranch = {
        children: new Map<string, MutablePathBranch>(),
        leaves: [],
        pathKey,
        segmentLabel: segment,
      };

      currentNode.children.set(segment, childNode);
      currentNode = childNode;
    });

    currentNode.leaves.push(session);
  }

  return materializePathNodes(root);
}

function materializePathNodes(branch: MutablePathBranch): SessionPathNode[] {
  const nodes: SessionPathNode[] = [];
  const branchEntries = Array.from(branch.children.entries());

  branchEntries.forEach(([, childBranch]) => {
    const childNodes = materializePathNodes(childBranch);

    nodes.push({
      branchType: "path",
      children: childNodes,
      kind: "branch",
      pathKey: childBranch.pathKey,
      searchText: buildSearchText(childBranch.segmentLabel),
      segmentLabel: childBranch.segmentLabel,
    });
  });

  const rootLeaves = branch.leaves.map((session) => ({
    kind: "leaf" as const,
    searchText: buildSearchText(session.host, session.path, session.url, session.method, session.responseMimeType ?? ""),
    segmentLabel: getSessionTreeLeafLabel(session),
    session,
  }));

  return [...nodes, ...rootLeaves];
}

function buildSearchText(...parts: string[]): string {
  return parts.join(" ").trim().toLowerCase();
}

function buildAggregateTree(groups: SessionHostGroup[]): SessionPathNode[] {
  return groups.map((group) => {
    const branchPathKey = `host:${group.label}`;

    return {
      branchType: "host" as const,
      children: prefixBranchPathKeys(group.tree, branchPathKey),
      host: group.host ?? group.label,
      kind: "branch" as const,
      pathKey: branchPathKey,
      searchText: buildSearchText(group.label),
      segmentLabel: group.label,
    };
  });
}

function prefixBranchPathKeys(nodes: SessionPathNode[], prefix: string): SessionPathNode[] {
  return nodes.map((node) => {
    if (node.kind !== "branch") {
      return node;
    }

    return {
      ...node,
      children: prefixBranchPathKeys(node.children, prefix),
      pathKey: `${prefix}/${node.pathKey}`,
    };
  });
}

function splitSessionPath(path: string): { pathname: string; search: string } {
  const normalizedPath = path.trim();

  if (!normalizedPath) {
    return { pathname: "/", search: "" };
  }

  const questionMarkIndex = normalizedPath.indexOf("?");

  if (questionMarkIndex === -1) {
    return { pathname: normalizedPath, search: "" };
  }

  return {
    pathname: normalizedPath.slice(0, questionMarkIndex) || "/",
    search: normalizedPath.slice(questionMarkIndex),
  };
}

function shouldGroupDirectoryQueryAtPathLevel(
  segments: string[],
  pathname: string,
  search: string,
): boolean {
  return segments.length === 1 && search.length > 0 && pathnameLooksLikeDirectory(pathname);
}

function getSessionTreeLeafLabel(session: SessionSummary): string {
  const { pathname, search } = splitSessionPath(session.path);
  const segments = pathnameSegments(pathname);

  if (shouldGroupDirectoryQueryAtPathLevel(segments, pathname, search)) {
    return "";
  }

  return getSessionLeafLabel(session);
}

function pathnameSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function pathnameLooksLikeDirectory(path: string): boolean {
  const { pathname } = splitSessionPath(path);

  return pathname.endsWith("/") || !pathnameSegments(pathname).at(-1)?.includes(".");
}
