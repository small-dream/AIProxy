import { Alert, Box, Paper, Stack } from "@mui/material";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { SessionDetail, SessionSummary } from "@aiproxy/shared-types";

import { SessionContainerTabs } from "@/features/sessions/components/SessionContainerTabs";
import { SessionExplorerPane } from "@/features/sessions/components/SessionExplorerPane";
import { SessionInspectorWorkspace } from "@/features/sessions/components/SessionInspectorWorkspace";
import type { WorkspaceHandle } from "@/features/sessions/components/SessionInspectorWorkspace";
import type { RequestInspectorTab, ResponseInspectorTab } from "@/features/sessions/components/session-inspector.helpers";
import type { SessionHostGroup } from "@/features/sessions/session-explorer.helpers";

type SessionsWorkspacePanelProps = {
  activeContainerId: string;
  containerTabs: Array<{
    id: string;
    labelNumber: number;
  }>;
  detailErrorMessage: string | undefined;
  domainFilterValue: string;
  errorMessage: string | undefined;
  expandedHosts: string[];
  explorerWidth: number;
  groups: SessionHostGroup[];
  inspectorSplitRatio: number;
  isDetailLoading: boolean;
  isLoading: boolean;
  onAddContainer: () => void;
  onCloseContainer: (containerId: string) => void;
  onContextMenuHost: (host: string, event: React.MouseEvent) => void;
  onContextMenuSession: (session: SessionSummary, event: React.MouseEvent) => void;
  onCopyCurl: (() => void) | undefined;
  onCopyUrl: (() => void) | undefined;
  onDomainFilterChange: (value: string) => void;
  onInspectorResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onRepeat: (() => void) | undefined;
  onRequestCollapsedChange: (collapsed: boolean) => void;
  onRequestTabChange: (tab: RequestInspectorTab) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResponseTabChange: (tab: ResponseInspectorTab) => void;
  onSelectContainer: (containerId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onToggleHost: (host: string) => void;
  requestCollapsed: boolean;
  requestTab: RequestInspectorTab;
  responseTab: ResponseInspectorTab;
  sessionSelectionNonce: number;
  runtimeErrorMessage: string | undefined;
  selectedSession: SessionSummary | undefined;
  selectedSessionDetail: SessionDetail | undefined;
  selectedSessionId: string | undefined;
  workspaceRef: RefObject<WorkspaceHandle | null>;
};

export function SessionsWorkspacePanel({
  activeContainerId,
  containerTabs,
  detailErrorMessage,
  domainFilterValue,
  errorMessage,
  expandedHosts,
  explorerWidth,
  groups,
  inspectorSplitRatio,
  isDetailLoading,
  isLoading,
  onAddContainer,
  onCloseContainer,
  onContextMenuHost,
  onContextMenuSession,
  onCopyCurl,
  onCopyUrl,
  onDomainFilterChange,
  onInspectorResizeStart,
  onRepeat,
  onRequestCollapsedChange,
  onRequestTabChange,
  onResizeStart,
  onResponseTabChange,
  onSelectContainer,
  onSelectSession,
  onToggleHost,
  requestCollapsed,
  requestTab,
  responseTab,
  sessionSelectionNonce,
  runtimeErrorMessage,
  selectedSession,
  selectedSessionDetail,
  selectedSessionId,
  workspaceRef,
}: SessionsWorkspacePanelProps) {
  return (
    <Stack spacing={0.375} sx={{ height: "100%", minHeight: 0 }}>
      {runtimeErrorMessage ? (
        <Alert severity="error">
          {runtimeErrorMessage}
        </Alert>
      ) : null}

      <Paper
        elevation={0}
        sx={{
          flex: 1,
          border: 1,
          borderColor: "divider",
          borderRadius: 0,
          boxShadow: "none",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
        variant="outlined"
      >
        <SessionContainerTabs
          containers={containerTabs.map((container) => ({
            ...container,
            isActive: container.id === activeContainerId,
          }))}
          onAddContainer={onAddContainer}
          onCloseContainer={onCloseContainer}
          onSelectContainer={onSelectContainer}
        />

        <Box
          sx={{
            display: "grid",
            flex: 1,
            gap: 0,
            gridTemplateColumns: {
              lg: `${explorerWidth}px 8px minmax(0, 1fr)`,
              xs: "1fr",
            },
            minHeight: 0,
          }}
        >
          <SessionExplorerPane
            domainFilterValue={domainFilterValue}
            errorMessage={errorMessage}
            expandedHosts={expandedHosts}
            groups={groups}
            isLoading={isLoading}
            onDomainFilterChange={onDomainFilterChange}
            onContextMenuHost={onContextMenuHost}
            onContextMenuSession={onContextMenuSession}
            onSelectSession={onSelectSession}
            onToggleHost={onToggleHost}
            selectedSessionId={selectedSessionId}
          />

          <Box
            aria-hidden
            onPointerDown={onResizeStart}
            sx={{
              alignItems: "center",
              cursor: "col-resize",
              display: { lg: "flex", xs: "none" },
              justifyContent: "center",
              minHeight: 0,
              position: "relative",
              touchAction: "none",
              userSelect: "none",
              "&::before": {
                bgcolor: "divider",
                borderRadius: 999,
                content: '""',
                height: "100%",
                opacity: 0.7,
                transition: "background-color 120ms ease, opacity 120ms ease",
                width: 2,
              },
              "&:hover::before": {
                bgcolor: "primary.main",
                opacity: 1,
              },
            }}
          />

          <SessionInspectorWorkspace
            ref={workspaceRef}
            detailErrorMessage={detailErrorMessage}
            inspectorSplitRatio={inspectorSplitRatio}
            isDetailLoading={isDetailLoading}
            onCopyCurl={onCopyCurl}
            onCopyUrl={onCopyUrl}
            onInspectorResizeStart={onInspectorResizeStart}
            onRepeat={onRepeat}
            onRequestCollapsedChange={onRequestCollapsedChange}
            onRequestTabChange={onRequestTabChange}
            onResponseTabChange={onResponseTabChange}
            requestCollapsed={requestCollapsed}
            requestTab={requestTab}
            responseTab={responseTab}
            sessionSelectionNonce={sessionSelectionNonce}
            selectedSessionDetail={selectedSessionDetail}
            selectedSession={selectedSession}
          />
        </Box>
      </Paper>
    </Stack>
  );
}
