import type { SessionSummary } from "@pharles/shared-types";

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
  | "warning";

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
  focusedHost?: string | null;
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
  options: BuildSessionHostGroupsOptions = {},
): SessionHostGroup[] {
  const groupsByHost = new Map<string, SessionSummary[]>();

  for (const session of sessions) {
    if (!matchesKeyword(session, keyword)) {
      continue;
    }

    const host = normalizeHost(session.host);
    const existingGroup = groupsByHost.get(host) ?? [];

    existingGroup.push(session);
    groupsByHost.set(host, existingGroup);
  }

  const hostGroups = Array.from(groupsByHost.entries()).map(([host, groupedSessions]) =>
    createHostGroup(host, groupedSessions),
  );

  const normalizedFocusedHost = normalizeOptionalHost(options.focusedHost);

  if (!normalizedFocusedHost) {
    return hostGroups;
  }

  const focusedGroup = hostGroups.find((group) => group.host === normalizedFocusedHost);

  if (!focusedGroup) {
    return hostGroups;
  }

  const unfocusedGroups = hostGroups.filter((group) => group.host !== normalizedFocusedHost);

  if (unfocusedGroups.length === 0) {
    return [focusedGroup];
  }

  return [
    focusedGroup,
    createAggregateGroup(unfocusedGroups, options.unfocusedLabel ?? "Unfocused"),
  ];
}

export function reconcileExpandedKeys(
  expandedKeys: string[],
  groups: SessionHostGroup[],
): string[] {
  const availableKeys = new Set<string>();

  for (const group of groups) {
    availableKeys.add(group.key);
    collectBranchKeys(group.tree, group.key, availableKeys);
  }

  return expandedKeys.filter((key) => availableKeys.has(key));
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
  ];

  return haystacks.some((value) => value.toLowerCase().includes(normalizedKeyword));
}

function normalizeHost(host: string): string {
  const normalizedHost = host.trim();

  return normalizedHost.length > 0 ? normalizedHost : "<unknown>";
}

function normalizeOptionalHost(host?: string | null): string | null {
  if (!host) {
    return null;
  }

  const normalizedHost = host.trim();

  return normalizedHost.length > 0 ? normalizedHost : null;
}

function createHostGroup(host: string, groupedSessions: SessionSummary[]): SessionHostGroup {
  const orderedSessions = [...groupedSessions];

  return {
    host,
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
