import type { ComposedRequestInput, HeaderEntry, SessionSummary } from "@aiproxy/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from "react";

import { useI18n } from "@/i18n";
import { downloadTextFile } from "@/lib/download";
import { saveSessionToCollection, sendComposedRequest } from "@/services/commands";
import { logDevWarn } from "@/services/logger/dev-logger";

import { getRawMessageText } from "@/features/sessions/components/session-inspector.helpers";
import type { SaveResponseFilesTarget } from "@/features/sessions/components/SaveResponseFilesDialog";
import type { BodyType, RawLanguage } from "@/features/compose/types";
import { buildComposeLoadInput } from "@/features/sessions/session-compose.helpers";
import {
  buildPendingComposedSessionDetail,
  removeSessionSummary,
  replaceSessionSummary,
  upsertSessionSummary,
} from "@/features/sessions/session-cache.helpers";
import { ensureSessionDetailContent } from "@/features/sessions/session-detail-content";
import { buildCurlCommand, getBodyText } from "@/features/sessions/session-export.helpers";
import { guessExtension } from "@/features/sessions/session-ui.helpers";
import { SESSION_DETAIL_QUERY_KEY } from "@/features/sessions/use-session-detail";
import { SESSIONS_QUERY_KEY } from "@/features/sessions/use-sessions";

type LoadFromSessionInput = {
  bodyType?: BodyType;
  body?: string;
  formDataEntries?: HeaderEntry[];
  headers: HeaderEntry[];
  method: string;
  rawLanguage?: RawLanguage;
  url: string;
  urlEncodedEntries?: HeaderEntry[];
};

type UseSessionContextActionsParams = {
  loadFromSession: (input: LoadFromSessionInput) => void;
  navigate: (path: string) => void;
  setFocusedHosts: Dispatch<SetStateAction<Set<string>>>;
  setIgnoredHosts: Dispatch<SetStateAction<Set<string>>>;
};

type RepeatSessionCallbacks = {
  onFailure?: (pendingSessionId: string) => void;
  onPending?: (summary: SessionSummary) => void;
  onSuccess?: (pendingSessionId: string, summary: SessionSummary) => void;
};

export function useSessionContextActions({
  loadFromSession,
  navigate,
  setFocusedHosts,
  setIgnoredHosts,
}: UseSessionContextActionsParams) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ left: number; top: number }>();
  const [contextMenuSession, setContextMenuSession] = useState<SessionSummary | null>(null);
  const [domainContextMenuAnchor, setDomainContextMenuAnchor] = useState<{
    left: number;
    top: number;
  }>();
  const [contextMenuHost, setContextMenuHost] = useState<string | null>(null);
  const [folderContextMenuAnchor, setFolderContextMenuAnchor] = useState<{
    left: number;
    top: number;
  }>();
  const [folderContextTarget, setFolderContextTarget] = useState<SaveResponseFilesTarget | null>(
    null,
  );
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null);

  // Save-to-collection dialog state
  const [saveToCollectionSession, setSaveToCollectionSession] = useState<SessionSummary | null>(
    null,
  );

  // Only one of the three tree context menus may be open at a time, so each
  // opener clears the other two.
  const handleContextMenu = useCallback((session: SessionSummary, event: ReactMouseEvent) => {
    event.preventDefault();
    setDomainContextMenuAnchor(undefined);
    setContextMenuHost(null);
    setFolderContextMenuAnchor(undefined);
    setFolderContextTarget(null);
    setContextMenuAnchor({ left: event.clientX - 2, top: event.clientY - 4 });
    setContextMenuSession(session);
  }, []);

  const handleContextMenuClose = useCallback(() => {
    setContextMenuAnchor(undefined);
    setContextMenuSession(null);
  }, []);

  const handleHostContextMenu = useCallback((host: string, event: ReactMouseEvent) => {
    event.preventDefault();
    setContextMenuAnchor(undefined);
    setContextMenuSession(null);
    setFolderContextMenuAnchor(undefined);
    setFolderContextTarget(null);
    setDomainContextMenuAnchor({ left: event.clientX - 2, top: event.clientY - 4 });
    setContextMenuHost(host);
  }, []);

  const handleHostContextMenuClose = useCallback(() => {
    setDomainContextMenuAnchor(undefined);
    setContextMenuHost(null);
  }, []);

  const handleFolderContextMenu = useCallback(
    (target: SaveResponseFilesTarget, event: ReactMouseEvent) => {
      event.preventDefault();
      setContextMenuAnchor(undefined);
      setContextMenuSession(null);
      setDomainContextMenuAnchor(undefined);
      setContextMenuHost(null);
      setFolderContextMenuAnchor({ left: event.clientX - 2, top: event.clientY - 4 });
      setFolderContextTarget(target);
    },
    [],
  );

  const handleFolderContextMenuClose = useCallback(() => {
    setFolderContextMenuAnchor(undefined);
    setFolderContextTarget(null);
  }, []);

  const handleSnackbarClose = useCallback(() => {
    setSnackbarMessage(null);
  }, []);

  const showSnackbar = useCallback((message: string) => {
    setSnackbarMessage(message);
  }, []);

  const copyToClipboard = useCallback(
    async (text: string, message: string) => {
      if (!text) {
        return;
      }

      // P2 4.3-9: clipboard writes reject when the document loses focus or the
      // permission is denied — surface that instead of leaking an unhandled
      // rejection from a fire-and-forget menu action.
      try {
        await navigator.clipboard?.writeText(text);
        showSnackbar(message);
      } catch (error) {
        logDevWarn("ui.sessions", "context_menu_copy_failed", { error: String(error) });
        showSnackbar(t("contextMenu.copyFailed"));
      }
    },
    [showSnackbar, t],
  );

  const handleCopyUrl = useCallback(
    (session: SessionSummary) => {
      void copyToClipboard(session.url, t("contextMenu.copiedToClipboard"));
    },
    [copyToClipboard, t],
  );

  const handleCopyRequest = useCallback(
    async (session: SessionSummary) => {
      // P2 4.3-9: detail hydration can reject (command failure); report it via
      // snackbar instead of leaking an unhandled rejection from the menu click.
      try {
        let detail = await ensureSessionDetailContent(queryClient, session.id, {});
        let rawRequest = getRawMessageText(
          detail?.rawRequest,
          detail?.rawRequestHead,
          detail?.requestBody,
        );

        if (!rawRequest && detail?.requestBody?.textDeferred && detail.rawRequestHead) {
          detail = await ensureSessionDetailContent(queryClient, session.id, {
            includeRequestBodyText: true,
          });
          rawRequest = getRawMessageText(
            detail.rawRequest,
            detail.rawRequestHead,
            detail.requestBody,
          );
        }

        if (!rawRequest && detail?.rawRequestDeferred) {
          detail = await ensureSessionDetailContent(queryClient, session.id, {
            includeRawRequest: true,
          });
          rawRequest = getRawMessageText(
            detail.rawRequest,
            detail.rawRequestHead,
            detail.requestBody,
          );
        }

        if (!rawRequest) {
          return;
        }

        await copyToClipboard(rawRequest, t("contextMenu.copiedToClipboard"));
      } catch (error) {
        logDevWarn("ui.sessions", "context_menu_copy_failed", { error: String(error) });
        showSnackbar(t("contextMenu.copyFailed"));
      }
    },
    [copyToClipboard, queryClient, showSnackbar, t],
  );

  const handleCopyCurl = useCallback(
    async (session: SessionSummary) => {
      // P2 4.3-9: see handleCopyRequest — hydration failures must surface.
      try {
        const detail = await ensureSessionDetailContent(queryClient, session.id, {
          includeRequestBodyText: true,
        });

        if (!detail) {
          return;
        }

        await copyToClipboard(buildCurlCommand(detail), t("composePage.copiedCurl"));
      } catch (error) {
        logDevWarn("ui.sessions", "context_menu_copy_failed", { error: String(error) });
        showSnackbar(t("contextMenu.copyFailed"));
      }
    },
    [copyToClipboard, queryClient, showSnackbar, t],
  );

  const handleCopyResponse = useCallback(
    async (session: SessionSummary) => {
      // P2 4.3-9: see handleCopyRequest — hydration failures must surface.
      try {
        let detail = await ensureSessionDetailContent(queryClient, session.id, {});
        let rawResponse = getRawMessageText(
          detail?.rawResponse,
          detail?.rawResponseHead,
          detail?.responseBody,
        );

        if (!rawResponse && detail?.responseBody?.textDeferred && detail.rawResponseHead) {
          detail = await ensureSessionDetailContent(queryClient, session.id, {
            includeResponseBodyText: true,
          });
          rawResponse = getRawMessageText(
            detail.rawResponse,
            detail.rawResponseHead,
            detail.responseBody,
          );
        }

        if (!rawResponse && detail?.rawResponseDeferred) {
          detail = await ensureSessionDetailContent(queryClient, session.id, {
            includeRawResponse: true,
          });
          rawResponse = getRawMessageText(
            detail.rawResponse,
            detail.rawResponseHead,
            detail.responseBody,
          );
        }

        if (!rawResponse) {
          return;
        }

        await copyToClipboard(rawResponse, t("contextMenu.copiedToClipboard"));
      } catch (error) {
        logDevWarn("ui.sessions", "context_menu_copy_failed", { error: String(error) });
        showSnackbar(t("contextMenu.copyFailed"));
      }
    },
    [copyToClipboard, queryClient, showSnackbar, t],
  );

  const handleSaveResponse = useCallback(
    async (session: SessionSummary): Promise<boolean> => {
      const detail = await ensureSessionDetailContent(queryClient, session.id, {
        includeResponseBodyText: true,
      });
      const bodyText = getBodyText(detail?.responseBody);

      if (!bodyText) {
        return false;
      }

      const mimeType = detail?.responseBody?.mimeType ?? "application/octet-stream";
      const extension = guessExtension(mimeType);
      const filename = `${session.host.replace(/[^a-zA-Z0-9.-]/g, "_")}-${session.id.slice(0, 8)}.${extension}`;
      await downloadTextFile(filename, bodyText, mimeType);
      return true;
    },
    [queryClient],
  );

  const handleCompose = useCallback(
    async (session: SessionSummary) => {
      const detail = await ensureSessionDetailContent(queryClient, session.id, {
        includeRequestBodyText: true,
      });

      loadFromSession(buildComposeLoadInput(session, detail));
      navigate("/compose");
    },
    [loadFromSession, navigate, queryClient],
  );

  const handleRepeatDirect = useCallback(
    async (
      session: SessionSummary,
      callbacks: RepeatSessionCallbacks = {},
    ): Promise<SessionSummary | null> => {
      const pendingSessionId = `pending-repeat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pendingInput: ComposedRequestInput = {
        workspaceId: "default",
        method: session.method,
        url: session.url,
        headers: [],
      };
      const pendingDetail = buildPendingComposedSessionDetail(pendingInput, pendingSessionId);

      if (!pendingDetail) {
        showSnackbar(t("contextMenu.repeatFailed"));
        return null;
      }

      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
        upsertSessionSummary(currentSessions, pendingDetail.summary),
      );
      queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, pendingSessionId], pendingDetail);
      callbacks.onPending?.(pendingDetail.summary);

      try {
        const detail = await ensureSessionDetailContent(queryClient, session.id, {
          includeRequestBodyText: true,
        });

        if (!detail) {
          throw new Error("Session detail is unavailable");
        }

        const bodyText = detail.requestBody?.inlineText;
        const input: ComposedRequestInput = {
          workspaceId: "default",
          method: session.method,
          url: session.url,
          headers: detail.requestHeaders.map((header) => ({
            name: header.name,
            value: header.value,
          })),
          ...(bodyText ? { body: bodyText } : {}),
        };
        const hydratedPendingDetail = buildPendingComposedSessionDetail(input, pendingSessionId);

        if (hydratedPendingDetail) {
          queryClient.setQueryData(
            [SESSION_DETAIL_QUERY_KEY, pendingSessionId],
            hydratedPendingDetail,
          );
        }

        const repeatedDetail = await sendComposedRequest(input);

        queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
          replaceSessionSummary(currentSessions, pendingSessionId, repeatedDetail.summary),
        );
        queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, pendingSessionId] });
        queryClient.setQueryData([SESSION_DETAIL_QUERY_KEY, repeatedDetail.id], repeatedDetail);
        callbacks.onSuccess?.(pendingSessionId, repeatedDetail.summary);
        showSnackbar(t("contextMenu.repeatSucceeded"));
        return repeatedDetail.summary;
      } catch {
        queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (currentSessions = []) =>
          removeSessionSummary(currentSessions, pendingSessionId),
        );
        queryClient.removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY, pendingSessionId] });
        callbacks.onFailure?.(pendingSessionId);
        showSnackbar(t("contextMenu.repeatFailed"));
        return null;
      }
    },
    [queryClient, showSnackbar, t],
  );

  const handleFocusDomain = useCallback(
    (host: string) => {
      setFocusedHosts((currentHosts) => {
        const nextHosts = new Set(currentHosts);

        if (nextHosts.has(host)) {
          nextHosts.delete(host);
        } else {
          nextHosts.add(host);
        }

        return nextHosts;
      });
    },
    [setFocusedHosts],
  );

  const handleUnfocusDomain = useCallback(
    (host: string) => {
      setFocusedHosts((currentHosts) => {
        if (!currentHosts.has(host)) {
          return currentHosts;
        }

        const nextHosts = new Set(currentHosts);
        nextHosts.delete(host);
        return nextHosts;
      });
    },
    [setFocusedHosts],
  );

  const handleIgnoreDomain = useCallback(
    (host: string) => {
      setFocusedHosts((currentHosts) => {
        if (!currentHosts.has(host)) {
          return currentHosts;
        }

        const nextHosts = new Set(currentHosts);
        nextHosts.delete(host);
        return nextHosts;
      });
      setIgnoredHosts((currentHosts) => {
        const nextHosts = new Set(currentHosts);
        nextHosts.add(host);
        return nextHosts;
      });
    },
    [setFocusedHosts, setIgnoredHosts],
  );

  const handleStopIgnoringDomain = useCallback(
    (host: string) => {
      setIgnoredHosts((currentHosts) => {
        const nextHosts = new Set(currentHosts);
        nextHosts.delete(host);
        return nextHosts;
      });
    },
    [setIgnoredHosts],
  );

  const handleFocusHost = useCallback(
    (session: SessionSummary) => {
      handleFocusDomain(session.host);
    },
    [handleFocusDomain],
  );

  const handleUnfocusHost = useCallback(
    (session: SessionSummary) => {
      handleUnfocusDomain(session.host);
    },
    [handleUnfocusDomain],
  );

  const handleIgnoreHost = useCallback(
    (session: SessionSummary) => {
      handleIgnoreDomain(session.host);
    },
    [handleIgnoreDomain],
  );

  const handleStopIgnoringHost = useCallback(
    (session: SessionSummary) => {
      handleStopIgnoringDomain(session.host);
    },
    [handleStopIgnoringDomain],
  );

  const handleSaveToCollection = useCallback((session: SessionSummary) => {
    setSaveToCollectionSession(session);
  }, []);

  const handleSaveToCollectionCancel = useCallback(() => {
    setSaveToCollectionSession(null);
  }, []);

  const handleSaveToCollectionConfirm = useCallback(
    async (collectionId: string, name?: string) => {
      if (!saveToCollectionSession) return;
      try {
        await saveSessionToCollection({
          sessionId: saveToCollectionSession.id,
          collectionId,
          ...(name ? { name } : {}),
        });
        showSnackbar(t("collectionsPage.saved"));
        setSaveToCollectionSession(null);
      } catch {
        showSnackbar(t("collectionsPage.saveFailed"));
      }
    },
    [saveToCollectionSession, showSnackbar, t],
  );

  return {
    contextMenuAnchor,
    contextMenuHost,
    contextMenuSession,
    domainContextMenuAnchor,
    folderContextMenuAnchor,
    folderContextTarget,
    handleCompose,
    handleContextMenu,
    handleContextMenuClose,
    handleCopyCurl,
    handleCopyRequest,
    handleCopyResponse,
    handleCopyUrl,
    handleFocusDomain,
    handleFocusHost,
    handleFolderContextMenu,
    handleFolderContextMenuClose,
    handleHostContextMenu,
    handleHostContextMenuClose,
    handleIgnoreDomain,
    handleIgnoreHost,
    handleRepeatDirect,
    handleSaveResponse,
    handleSaveToCollection,
    handleSaveToCollectionCancel,
    handleSaveToCollectionConfirm,
    handleSnackbarClose,
    showSnackbar,
    handleStopIgnoringDomain,
    handleStopIgnoringHost,
    handleUnfocusDomain,
    handleUnfocusHost,
    saveToCollectionSession,
    snackbarMessage,
  };
}
