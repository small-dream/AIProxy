import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";
import { SessionsPage } from "@/pages/sessions";

const mockSetHeaderActions = vi.fn();
const mockLocation = { key: "default", pathname: "/", state: null };
const INSPECTOR_SPLIT_RATIO_STORAGE_KEY = "aiproxy.sessions.inspectorSplitRatio";

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
  useProxyStatus: () => ({ error: null, isLoading: false }),
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
  useSessions: () => ({ data: [], error: null, isLoading: false }),
}));

vi.mock("@/services/events", () => ({
  onSessionRemove: () => Promise.resolve(() => {}),
  onSessionUpsert: () => Promise.resolve(() => {}),
}));

vi.mock("@/services/commands", () => ({
  setFocusedHosts: () => Promise.resolve(),
}));

vi.mock("@/features/sessions/components/SessionsWorkspacePanel", () => ({
  SessionsWorkspacePanel: ({
    inspectorSplitRatio,
    onInspectorResizeStart,
  }: {
    inspectorSplitRatio: number;
    onInspectorResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  }) => {
    const gridRef = useRef<HTMLDivElement | null>(null);
    const splitterRef = useRef<HTMLDivElement | null>(null);

    return (
      <div>
        <div data-testid="inspector-ratio">{String(inspectorSplitRatio)}</div>
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

describe("SessionsPage inspector split ratio", () => {
  beforeEach(() => {
    mockSetHeaderActions.mockReset();
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
});
