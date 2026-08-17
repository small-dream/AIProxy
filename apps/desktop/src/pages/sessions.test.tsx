import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SessionSummary } from "@aiproxy/shared-types";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { SessionsPage } from "@/pages/sessions";
import { useSessionContainerStore } from "@/features/sessions/session-container.store";

const mockSetHeaderActions = vi.fn();
const mockLocation: { key: string; pathname: string; state: unknown } = {
  key: "default",
  pathname: "/",
  state: null,
};
const testState = vi.hoisted(() => ({
  runtimeSessions: [] as SessionSummary[],
}));
const EXPANDED_HOSTS_STORAGE_KEY = "aiproxy.sessions.expandedHosts";
const INSPECTOR_SPLIT_RATIO_STORAGE_KEY = "aiproxy.sessions.inspectorSplitRatio";
const SELECTED_SESSION_ID_STORAGE_KEY = "aiproxy.sessions.selectedSessionId";

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");

  return {
    ...actual,
    useLocation: () => mockLocation,
    useNavigate: () => vi.fn(),
    useOutletContext: () => ({ setHeaderActions: mockSetHeaderActions }),
  };
});

vi.mock("@/features/compose/compose-editor.store", () => ({
  useComposeEditorStore: (selector: (store: { loadFromSession: () => void }) => unknown) =>
    selector({ loadFromSession: vi.fn() }),
}));

vi.mock("@/features/compose/use-compose-request", () => ({
  useSendComposedRequest: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/features/proxy-status/use-proxy-status", () => ({
  useClearSessions: () => ({ isPending: false, mutate: vi.fn() }),
  useProxyStatus: () => ({
    data: {
      activeWorkspaceId: "default",
      http2Enabled: true,
      port: 8888,
      running: false,
      sslEnabled: true,
    },
    error: null,
    isLoading: false,
  }),
  useStartProxy: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/features/workspace-manager/use-workspaces", () => ({
  useWorkspaces: () => ({
    data: [
      {
        createdAt: "2026-01-01T00:00:00Z",
        http2Enabled: true,
        id: "default",
        name: "Default",
        proxyPort: 8888,
        sslBlindHosts: [],
        sslEnabled: true,
        storagePath: "",
        systemProxyEnabled: false,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  }),
  useUpdateWorkspace: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/features/sessions/use-session-context-actions", () => ({
  useSessionContextActions: () => ({
    contextMenuAnchor: null,
    contextMenuHost: null,
    contextMenuSession: null,
    domainContextMenuAnchor: null,
    handleCompose: vi.fn(),
    handleContextMenu: vi.fn(),
    handleContextMenuClose: vi.fn(),
    handleCopyCurl: vi.fn(),
    handleCopyRequest: vi.fn(),
    handleCopyResponse: vi.fn(),
    handleCopyUrl: vi.fn(),
    handleFocusDomain: vi.fn(),
    handleFocusHost: vi.fn(),
    handleHostContextMenu: vi.fn(),
    handleHostContextMenuClose: vi.fn(),
    handleIgnoreDomain: vi.fn(),
    handleIgnoreHost: vi.fn(),
    handleRepeatDirect: vi.fn(),
    handleSaveResponse: vi.fn(),
    handleSaveToCollection: vi.fn(),
    handleSaveToCollectionCancel: vi.fn(),
    handleSaveToCollectionConfirm: vi.fn(),
    handleSnackbarClose: vi.fn(),
    handleStopIgnoringDomain: vi.fn(),
    handleStopIgnoringHost: vi.fn(),
    handleUnfocusDomain: vi.fn(),
    handleUnfocusHost: vi.fn(),
    saveToCollectionSession: null,
    snackbarMessage: null,
  }),
}));

vi.mock("@/features/sessions/use-session-detail", () => ({
  useSessionDetail: () => ({ data: undefined, error: null, isLoading: false }),
}));

vi.mock("@/features/sessions/use-session-events", () => ({
  useSessionEvents: () => undefined,
}));

vi.mock("@/features/sessions/use-sessions", () => ({
  useSessions: () => ({ data: testState.runtimeSessions, error: null, isLoading: false }),
}));

vi.mock("@/services/events", () => ({
  onSessionRemove: () => Promise.resolve(() => {}),
  onSessionsCleared: () => Promise.resolve(() => {}),
  onSessionsRemoved: () => Promise.resolve(() => {}),
  onSessionUpsert: () => Promise.resolve(() => {}),
}));

vi.mock("@/services/commands", () => ({
  isCapturedSessionNotFoundError: () => false,
  setFocusedHosts: () => Promise.resolve(),
  setMenuLocale: () => Promise.resolve(),
}));

vi.mock("@/components/shared/SetupChecklistCard", () => ({
  SetupChecklistCard: () => null,
}));

vi.mock("@/features/sessions/components/SessionsWorkspacePanel", () => ({
  SessionsWorkspacePanel: ({
    expandedHosts,
    groups,
    inspectorSplitRatio,
    onInspectorResizeStart,
    onSelectSession,
    onToggleHost,
    searchValue,
    selectedSessionId,
  }: {
    expandedHosts: string[];
    groups: unknown[];
    inspectorSplitRatio: number;
    onInspectorResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onSelectSession: (sessionId: string) => void;
    onToggleHost: (host: string) => void;
    searchValue: string;
    selectedSessionId: string | undefined;
  }) => {
    const gridRef = useRef<HTMLDivElement | null>(null);
    const splitterRef = useRef<HTMLDivElement | null>(null);

    return (
      <div>
        <div data-testid="expanded-hosts">{expandedHosts.join("|")}</div>
        <div data-testid="search-value">{searchValue}</div>
        <div data-testid="group-count">{String(groups.length)}</div>
        <div data-testid="inspector-ratio">{String(inspectorSplitRatio)}</div>
        <div data-testid="selected-session-id">{selectedSessionId ?? "none"}</div>
        <div data-testid="inspector-grid" ref={gridRef}>
          <div
            data-testid="session-inspector-splitter"
            ref={splitterRef}
            onPointerDown={onInspectorResizeStart}
          />
        </div>
        <button
          data-testid="trigger-inspector-resize"
          onClick={() => {
            Object.defineProperty(gridRef.current, "getBoundingClientRect", {
              configurable: true,
              value: () => ({
                bottom: 400,
                height: 400,
                left: 0,
                right: 800,
                top: 0,
                width: 800,
                x: 0,
                y: 0,
                toJSON: () => ({}),
              }),
            });

            onInspectorResizeStart({
              clientY: 280,
              currentTarget: splitterRef.current,
              pointerId: 1,
              preventDefault: () => {},
            } as ReactPointerEvent<HTMLDivElement>);
          }}
          type="button"
        >
          resize
        </button>
        <button
          data-testid="toggle-api-host"
          onClick={() => onToggleHost("api.example.com")}
          type="button"
        >
          toggle host
        </button>
        <button
          data-testid="select-session"
          onClick={() => onSelectSession("session-1")}
          type="button"
        >
          select session
        </button>
      </div>
    );
  },
}));

vi.mock("@/features/sessions/components/SessionExportDialog", () => ({
  SessionExportDialog: () => null,
}));

vi.mock("@/features/sessions/components/SessionContextMenu", () => ({
  SessionContextMenu: () => null,
}));

vi.mock("@/features/sessions/components/DomainContextMenu", () => ({
  DomainContextMenu: () => null,
}));

vi.mock("@/features/collections/components/SaveToCollectionDialog", () => ({
  SaveToCollectionDialog: () => null,
}));

function createSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    durationMs: 42,
    finishedAt: "2026-04-11T10:00:03.000Z",
    host: "api.example.com",
    id: "session-1",
    method: "GET",
    path: "/users",
    protocol: "HTTP/1.1",
    responseMimeType: "application/json; charset=utf-8",
    sizeBytes: 512,
    startedAt: "2026-04-11T10:00:00.000Z",
    statusCode: 200,
    url: "http://api.example.com/users",
    ...overrides,
  };
}

describe("SessionsPage inspector split ratio", () => {
  beforeEach(() => {
    mockSetHeaderActions.mockReset();
    mockLocation.key = "default";
    mockLocation.pathname = "/";
    mockLocation.state = null;
    testState.runtimeSessions = [];
    useSessionContainerStore.getState().clearSessions();
    const storage = new Map<string, string>();

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });

    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("loads the stored inspector split ratio on first render", () => {
    window.localStorage.setItem(INSPECTOR_SPLIT_RATIO_STORAGE_KEY, "0.62");

    render(
      <AppProviders>
        <SessionsPage />
      </AppProviders>,
    );

    expect(screen.getByTestId("inspector-ratio")).toHaveTextContent("0.62");
  });

  it("persists the updated inspector split ratio after dragging the splitter", async () => {
    render(
      <AppProviders>
        <SessionsPage />
      </AppProviders>,
    );

    fireEvent.click(screen.getByTestId("trigger-inspector-resize"));

    await waitFor(() => {
      expect(screen.getByTestId("inspector-ratio")).toHaveTextContent("0.7");
      expect(window.localStorage.getItem(INSPECTOR_SPLIT_RATIO_STORAGE_KEY)).toBe("0.7");
    });
  });

  it("restores expanded session domains after the sessions page remounts", async () => {
    testState.runtimeSessions = [createSessionSummary({})];
    window.localStorage.setItem(EXPANDED_HOSTS_STORAGE_KEY, JSON.stringify(["api.example.com"]));

    render(
      <AppProviders>
        <SessionsPage />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("group-count")).toHaveTextContent("1");
      expect(screen.getByTestId("expanded-hosts")).toHaveTextContent("api.example.com");
      expect(window.localStorage.getItem(EXPANDED_HOSTS_STORAGE_KEY)).toBe(
        JSON.stringify(["api.example.com"]),
      );
    });
  });

  it("persists selectedSessionId to localStorage when a session is selected", async () => {
    testState.runtimeSessions = [createSessionSummary({})];

    render(
      <AppProviders>
        <SessionsPage />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("group-count")).toHaveTextContent("1");
    });

    fireEvent.click(screen.getByTestId("select-session"));

    await waitFor(() => {
      expect(window.localStorage.getItem(SELECTED_SESSION_ID_STORAGE_KEY)).toBe("session-1");
    });
  });

  it("restores selectedSessionId after the sessions page remounts", async () => {
    testState.runtimeSessions = [createSessionSummary({})];
    window.localStorage.setItem(SELECTED_SESSION_ID_STORAGE_KEY, "session-1");

    render(
      <AppProviders>
        <SessionsPage />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("selected-session-id")).toHaveTextContent("session-1");
    });
  });

  it("applies a host filter passed from the insights page", async () => {
    testState.runtimeSessions = [createSessionSummary({})];
    mockLocation.key = "host-filter";
    mockLocation.state = {
      sessionHostFilter: {
        host: "api.example.com",
        requestedAt: 1,
      },
    };

    render(
      <AppProviders>
        <SessionsPage />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("search-value")).toHaveTextContent("api.example.com");
      expect(screen.getByTestId("expanded-hosts")).toHaveTextContent("api.example.com");
    });
  });
});
