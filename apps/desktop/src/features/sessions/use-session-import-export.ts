import { useCallback, useState } from "react";
import type { SessionSummary } from "@aiproxy/shared-types";
import type { SessionDetail } from "@aiproxy/shared-types";
import { type QueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";

import { useI18n } from "@/i18n";
import { downloadTextFile } from "@/lib/download";
import { readHarFile } from "@/services/commands";
import { upsertImportedSessions } from "@/features/sessions/imported-sessions.store";
import { upsertSessionSummary } from "@/features/sessions/session-cache.helpers";
import {
  buildHarArchive,
  buildHarExportFilename,
  loadSessionDetailsBatched,
} from "@/features/sessions/session-export.helpers";
import { parseHarArchive } from "@/features/sessions/session-import.helpers";
import {
  type SessionExportDialogScope,
  type SessionExportHostScope,
} from "@/features/sessions/components/SessionExportDialog";

export interface SessionImportExportState {
  exportDialogOpen: boolean;
  exportDialogInitialScope: SessionExportDialogScope | undefined;
  exportDialogHostScope: SessionExportHostScope | null;
  importSnackbarMessage: string | null;
  handleExportSession: (session: SessionSummary) => void;
  handleExportHost: (host: string) => void;
  handleImportSessions: (details: SessionDetail[]) => void;
  handleImportHarPickerOpen: () => Promise<void>;
  handleOpenExportDialog: (scope?: SessionExportDialogScope) => void;
  setExportDialogOpen: (open: boolean) => void;
  setExportDialogInitialScope: (scope: SessionExportDialogScope | undefined) => void;
  setExportDialogHostScope: (scope: SessionExportHostScope | null) => void;
  setImportSnackbarMessage: (message: string | null) => void;
}

export interface UseSessionImportExportParams {
  queryClient: QueryClient;
  visibleSessions: SessionSummary[];
  /** Called after importing to update the store and container. */
  onImportComplete: (details: SessionDetail[]) => void;
}

export function useSessionImportExport({
  queryClient,
  visibleSessions,
  onImportComplete,
}: UseSessionImportExportParams): SessionImportExportState {
  const { t } = useI18n();

  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportDialogInitialScope, setExportDialogInitialScope] =
    useState<SessionExportDialogScope>();
  const [exportDialogHostScope, setExportDialogHostScope] =
    useState<SessionExportHostScope | null>(null);
  const [importSnackbarMessage, setImportSnackbarMessage] = useState<string | null>(null);

  const handleExportSession = useCallback(
    (session: SessionSummary) => {
      void exportSessionsAsHar(
        queryClient,
        [session],
        buildHarExportFilename("request", session.host),
      ).catch((error) => {
        setImportSnackbarMessage(
          error instanceof Error ? error.message : t("common.errors.unexpected"),
        );
      });
    },
    [queryClient, t],
  );

  const handleOpenExportDialog = useCallback((scope?: SessionExportDialogScope) => {
    setExportDialogHostScope(null);
    setExportDialogInitialScope(scope);
    setExportDialogOpen(true);
  }, []);

  const handleExportHost = useCallback(
    (host: string) => {
      const hostSessions = visibleSessions.filter((s) => s.host === host);
      void exportSessionsAsHar(
        queryClient,
        hostSessions,
        buildHarExportFilename("host", host),
      ).catch((error) => {
        setImportSnackbarMessage(
          error instanceof Error ? error.message : t("common.errors.unexpected"),
        );
      });
    },
    [queryClient, t, visibleSessions],
  );

  const handleImportSessions = useCallback(
    (details: SessionDetail[]) => {
      if (details.length === 0) return;

      upsertImportedSessions(details);

      queryClient.setQueryData<SessionSummary[]>(["sessions"], (current = []) => {
        let next = current;
        for (const detail of details) {
          next = upsertSessionSummary(next, detail.summary);
        }
        return next;
      });

      for (const detail of details) {
        queryClient.setQueryData(["session-detail", detail.id], detail);
      }

      onImportComplete(details);

      setImportSnackbarMessage(
        t("sessionsImport.messages.importedHar", { count: details.length }),
      );
    },
    [queryClient, t, onImportComplete],
  );

  const handleImportHarPickerOpen = useCallback(async () => {
    try {
      const selected = await open({
        directory: false,
        filters: [{ name: "HAR", extensions: ["har"] }],
        multiple: false,
        title: t("sessionsImport.title"),
      });

      if (!selected || Array.isArray(selected)) return;
      if (!selected.toLowerCase().endsWith(".har")) {
        throw new Error(t("sessionsImport.invalidFileType"));
      }

      const contents = await readHarFile(selected);
      const details = parseHarArchive(contents);
      handleImportSessions(details);
    } catch (error) {
      setImportSnackbarMessage(
        error instanceof Error ? error.message : t("common.errors.unexpected"),
      );
    }
  }, [handleImportSessions, t]);

  return {
    exportDialogOpen,
    exportDialogInitialScope,
    exportDialogHostScope,
    importSnackbarMessage,
    handleExportSession,
    handleExportHost,
    handleImportSessions,
    handleImportHarPickerOpen,
    handleOpenExportDialog,
    setExportDialogOpen,
    setExportDialogInitialScope,
    setExportDialogHostScope,
    setImportSnackbarMessage,
  };
}

/** Shared helper — kept module-private because it needs QueryClient. */
async function exportSessionsAsHar(
  queryClient: QueryClient,
  sessions: SessionSummary[],
  filename: string,
) {
  if (sessions.length === 0) return;
  const details = await loadSessionDetailsBatched(queryClient, sessions);
  await downloadTextFile(
    filename,
    JSON.stringify(buildHarArchive(details), null, 2),
    "application/json",
    { revealInFolder: true },
  );
}
