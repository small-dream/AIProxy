import type { SessionSummary } from "@aiproxy/shared-types";

import {
  DEFAULT_REQUEST_SPLIT_RATIO,
  type RequestInspectorTab,
  type ResponseInspectorTab,
} from "./components/session-inspector.helpers";

export type SessionContainer = {
  domainFilterValue: string;
  expandedHosts: string[];
  id: string;
  inspectorSplitRatio: number;
  labelNumber: number;
  requestCollapsed: boolean;
  requestTab: RequestInspectorTab;
  responseTab: ResponseInspectorTab;
  searchValue: string;
  selectedSessionId?: string;
  sessionIds: string[];
};

export type SessionContainerState = {
  activeContainerId: string;
  containers: SessionContainer[];
  hydrated: boolean;
  nextContainerNumber: number;
  sessionOwnerById: Record<string, string>;
  sessionSummaryById: Record<string, SessionSummary>;
};

type CreateSessionContainerOptions = {
  expandedHosts?: string[];
  inspectorSplitRatio?: number;
  labelNumber: number;
  requestCollapsed?: boolean;
  requestTab?: RequestInspectorTab;
  responseTab?: ResponseInspectorTab;
  selectedSessionId?: string;
};

export function createInitialSessionContainerState(
  options?: Pick<CreateSessionContainerOptions, "expandedHosts" | "inspectorSplitRatio" | "requestCollapsed" | "requestTab" | "responseTab" | "selectedSessionId">,
): SessionContainerState {
  const initialContainerOptions: CreateSessionContainerOptions = {
    labelNumber: 1,
  };

  if (options?.expandedHosts) {
    initialContainerOptions.expandedHosts = options.expandedHosts;
  }

  if (typeof options?.inspectorSplitRatio === "number") {
    initialContainerOptions.inspectorSplitRatio = options.inspectorSplitRatio;
  }

  if (typeof options?.requestCollapsed === "boolean") {
    initialContainerOptions.requestCollapsed = options.requestCollapsed;
  }

  if (options?.requestTab) {
    initialContainerOptions.requestTab = options.requestTab;
  }

  if (options?.responseTab) {
    initialContainerOptions.responseTab = options.responseTab;
  }

  if (options?.selectedSessionId) {
    initialContainerOptions.selectedSessionId = options.selectedSessionId;
  }

  const initialContainer = createSessionContainer(initialContainerOptions);

  return {
    activeContainerId: initialContainer.id,
    containers: [initialContainer],
    hydrated: false,
    nextContainerNumber: 2,
    sessionOwnerById: {},
    sessionSummaryById: {},
  };
}

export function createAdditionalSessionContainer(state: SessionContainerState): SessionContainerState {
  const activeContainer = getSessionContainerById(state, state.activeContainerId);
  const nextContainer = createSessionContainer({
    labelNumber: state.nextContainerNumber,
    ...(typeof activeContainer?.inspectorSplitRatio === "number"
      ? { inspectorSplitRatio: activeContainer.inspectorSplitRatio }
      : {}),
  });

  return {
    ...state,
    activeContainerId: nextContainer.id,
    containers: [...state.containers, nextContainer],
    nextContainerNumber: state.nextContainerNumber + 1,
  };
}

export function closeSessionContainer(
  state: SessionContainerState,
  containerId: string,
): SessionContainerState {
  if (state.containers.length <= 1) {
    return state;
  }

  const removedIndex = state.containers.findIndex((container) => container.id === containerId);

  if (removedIndex === -1) {
    return state;
  }

  const removedContainer = state.containers[removedIndex];

  if (!removedContainer) {
    return state;
  }

  const nextContainers = state.containers.filter((container) => container.id !== containerId);
  const nextActiveContainerId =
    state.activeContainerId === containerId
      ? nextContainers[Math.max(0, removedIndex - 1)]?.id ?? nextContainers[0]!.id
      : state.activeContainerId;

  const nextOwnerById = { ...state.sessionOwnerById };
  const nextSummaryById = { ...state.sessionSummaryById };

  for (const sessionId of removedContainer.sessionIds) {
    delete nextOwnerById[sessionId];
    delete nextSummaryById[sessionId];
  }

  return {
    ...state,
    activeContainerId: nextActiveContainerId,
    containers: nextContainers,
    sessionOwnerById: nextOwnerById,
    sessionSummaryById: nextSummaryById,
  };
}

export function setActiveSessionContainer(
  state: SessionContainerState,
  containerId: string,
): SessionContainerState {
  if (!state.containers.some((container) => container.id === containerId)) {
    return state;
  }

  return {
    ...state,
    activeContainerId: containerId,
  };
}

export function updateActiveSessionContainer(
  state: SessionContainerState,
  updater: (container: SessionContainer) => SessionContainer,
): SessionContainerState {
  return updateSessionContainerById(state, state.activeContainerId, updater);
}

export function seedSessionContainers(
  state: SessionContainerState,
  sessions: SessionSummary[],
): SessionContainerState {
  const nextSummaryById = Object.fromEntries(sessions.map((session) => [session.id, session]));
  const nextOwnerById = Object.fromEntries(
    sessions.map((session) => [session.id, state.activeContainerId]),
  );
  const sessionIds = sessions.map((session) => session.id);

  return {
    ...state,
    containers: state.containers.map((container) => {
      if (container.id !== state.activeContainerId) {
        return container;
      }

      const isSelectedSessionValid = container.selectedSessionId
        ? sessionIds.includes(container.selectedSessionId)
        : false;

      const next = { ...container, sessionIds };
      if (!isSelectedSessionValid) {
        delete next.selectedSessionId;
      }
      return next;
    }),
    hydrated: true,
    sessionOwnerById: nextOwnerById,
    sessionSummaryById: nextSummaryById,
  };
}

export function upsertSessionContainerSummary(
  state: SessionContainerState,
  summary: SessionSummary,
): SessionContainerState {
  const ownerContainerId = state.sessionOwnerById[summary.id] ?? state.activeContainerId;
  const nextSummaryById = {
    ...state.sessionSummaryById,
    [summary.id]: summary,
  };

  const nextState = {
    ...state,
    sessionOwnerById: {
      ...state.sessionOwnerById,
      [summary.id]: ownerContainerId,
    },
    sessionSummaryById: nextSummaryById,
  };

  return updateSessionContainerById(nextState, ownerContainerId, (container) => {
    if (container.sessionIds.includes(summary.id)) {
      return container;
    }

    return {
      ...container,
      sessionIds: [...container.sessionIds, summary.id],
    };
  });
}

export function removeSessionContainerSummary(
  state: SessionContainerState,
  sessionId: string,
): SessionContainerState {
  const ownerContainerId = state.sessionOwnerById[sessionId];
  const nextOwnerById = { ...state.sessionOwnerById };
  const nextSummaryById = { ...state.sessionSummaryById };

  delete nextOwnerById[sessionId];
  delete nextSummaryById[sessionId];

  if (!ownerContainerId) {
    return {
      ...state,
      sessionOwnerById: nextOwnerById,
      sessionSummaryById: nextSummaryById,
    };
  }

  return updateSessionContainerById(
    {
      ...state,
      sessionOwnerById: nextOwnerById,
      sessionSummaryById: nextSummaryById,
    },
    ownerContainerId,
    (container) => {
      const removedIndex = container.sessionIds.indexOf(sessionId);

      if (removedIndex === -1) {
        return container;
      }

      const nextSessionIds = container.sessionIds.filter((id) => id !== sessionId);
      const nextSelectedSessionId =
        container.selectedSessionId === sessionId
          ? nextSessionIds[Math.min(removedIndex, nextSessionIds.length - 1)]
          : container.selectedSessionId;

      return buildContainerWithSelection(container, nextSessionIds, nextSelectedSessionId);
    },
  );
}

export function clearActiveSessionContainer(
  state: SessionContainerState,
): SessionContainerState {
  const activeContainer = getSessionContainerById(state, state.activeContainerId);

  if (!activeContainer) {
    return state;
  }

  const nextOwnerById = { ...state.sessionOwnerById };
  const nextSummaryById = { ...state.sessionSummaryById };

  for (const sessionId of activeContainer.sessionIds) {
    delete nextOwnerById[sessionId];
    delete nextSummaryById[sessionId];
  }

  return updateSessionContainerById(
    {
      ...state,
      sessionOwnerById: nextOwnerById,
      sessionSummaryById: nextSummaryById,
    },
    state.activeContainerId,
    (container) => buildContainerWithSelection(
      {
        ...container,
        expandedHosts: [],
        searchValue: "",
      },
      [],
    ),
  );
}

export function clearOtherSessionsInActiveContainer(
  state: SessionContainerState,
  keepSessionId: string,
): SessionContainerState {
  const activeContainer = getSessionContainerById(state, state.activeContainerId);

  if (!activeContainer || !activeContainer.sessionIds.includes(keepSessionId)) {
    return state;
  }

  const nextOwnerById = { ...state.sessionOwnerById };
  const nextSummaryById = { ...state.sessionSummaryById };

  for (const sessionId of activeContainer.sessionIds) {
    if (sessionId === keepSessionId) {
      continue;
    }

    delete nextOwnerById[sessionId];
    delete nextSummaryById[sessionId];
  }

  return updateSessionContainerById(
    {
      ...state,
      sessionOwnerById: nextOwnerById,
      sessionSummaryById: nextSummaryById,
    },
    state.activeContainerId,
    (container) => buildContainerWithSelection(container, [keepSessionId], keepSessionId),
  );
}

export function getSessionContainerById(
  state: SessionContainerState,
  containerId: string,
): SessionContainer | undefined {
  return state.containers.find((container) => container.id === containerId);
}

function createSessionContainer({
  expandedHosts = [],
  inspectorSplitRatio = DEFAULT_REQUEST_SPLIT_RATIO,
  labelNumber,
  requestCollapsed = false,
  requestTab = "query",
  responseTab = "overview",
  selectedSessionId,
}: CreateSessionContainerOptions): SessionContainer {
  return {
    domainFilterValue: "",
    expandedHosts,
    id: `session-container-${labelNumber}`,
    inspectorSplitRatio,
    labelNumber,
    requestCollapsed,
    requestTab,
    responseTab,
    searchValue: "",
    sessionIds: [],
    ...(selectedSessionId ? { selectedSessionId } : {}),
  };
}

function updateSessionContainerById(
  state: SessionContainerState,
  containerId: string,
  updater: (container: SessionContainer) => SessionContainer,
): SessionContainerState {
  let hasUpdated = false;

  const nextContainers = state.containers.map((container) => {
    if (container.id !== containerId) {
      return container;
    }

    hasUpdated = true;
    return updater(container);
  });

  if (!hasUpdated) {
    return state;
  }

  return {
    ...state,
    containers: nextContainers,
  };
}

function buildContainerWithSelection(
  container: Omit<SessionContainer, "selectedSessionId" | "sessionIds"> & {
    selectedSessionId?: string;
    sessionIds: string[];
  },
  sessionIds: string[],
  selectedSessionId?: string,
): SessionContainer {
  return {
    ...container,
    sessionIds,
    ...(selectedSessionId ? { selectedSessionId } : {}),
  };
}
