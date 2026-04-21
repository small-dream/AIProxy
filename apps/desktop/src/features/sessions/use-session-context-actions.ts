import type {
  ComposedRequestInput,
  SessionSummary,
} from "@aiproxy/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  SetStateAction,
} from "react";

import { useI18n } from "@/i18n";
import { downloadTextFile } from "@/lib/download";
import { saveSessionToCollection } from "@/services/commands";

import { getRawMessageText } from "@/features/sessions/components/session-inspector.helpers";
import { ensureSessionDetailContent } from "@/features/sessions/session-detail-content";
import { buildCurlCommand, getBodyText } from "@/features/sessions/session-export.helpers";
import { guessExtension } from "@/features/sessions/session-ui.helpers";

type LoadFromSessionInput = {
  body?: string;
  headers: Array<{ name: string; value: string }>;
  method: string;
  url: string;
};

type UseSessionContextActionsParams = {
  loadFromSession: (input: LoadFromSessionInput) => void;
  navigate: (path: string) => void;
  setFocusedHosts: Dispatch<SetStateAction<Set<string>>>;
  setIgnoredHosts: Dispatch<SetStateAction<Set<string>>>;
  sendComposedRequest: {
    mutateAsync: (input: ComposedRequestInput) => Promise<unknown>;
  };
};

export function useSessionContextActions({
  loadFromSession,
  navigate,
  setFocusedHosts,
  setIgnoredHosts,
  sendComposedRequest,
}: UseSessionContextActionsParams) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [contextMenuAnchor, setContextMenuAnchor] = useState<{ left: number; top: number }>();
  const [contextMenuSession, setContextMenuSession] = useState<SessionSummary | null>(null);
  const [domainContextMenuAnchor, setDomainContextMenuAnchor] = useState<{ left: number; top: number }>();
  const [contextMenuHost, setContextMenuHost] = useState<string | null>(null);
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null);

  // Save-to-collection dialog state
  const [saveToCollectionSession, setSaveToCollectionSession] = useState<SessionSummary | null>(null);

  const handleContextMenu = useCallback((session: SessionSummary, event: ReactMouseEvent) => {
    event.preventDefault();
    setDomainContextMenuAnchor(undefined);
    setContextMenuHost(null);
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
    setDomainContextMenuAnchor({ left: event.clientX - 2, top: event.clientY - 4 });
    setContextMenuHost(host);
  }, []);

  const handleHostContextMenuClose = useCallback(() => {
    setDomainContextMenuAnchor(undefined);
    setContextMenuHost(null);
  }, []);

  const handleSnackbarClose = useCallback(() => {
    setSnackbarMessage(null);
  }, []);

  const showSnackbar = useCallback((message: string) => {
    setSnackbarMessage(message);
  }, []);

  const copyToClipboard = useCallback(async (text: string, message: string) => {
    if (!text) {
      return;
    }

    await navigator.clipboard?.writeText(text);
    showSnackbar(message);
  }, [showSnackbar]);

  const handleCopyUrl = useCallback((session: SessionSummary) => {
    void copyToClipboard(session.url, t("contextMenu.copiedToClipboard"));
  }, [copyToClipboard, t]);

  const handleCopyRequest = useCallback(async (session: SessionSummary) => {
    let detail = await ensureSessionDetailContent(queryClient, session.id, {});
    let rawRequest = getRawMessageText(detail?.rawRequest, detail?.rawRequestHead, detail?.requestBody);

    if (!rawRequest && detail?.requestBody?.textDeferred && detail.rawRequestHead) {
      detail = await ensureSessionDetailContent(queryClient, session.id, {
        includeRequestBodyText: true,
      });
      rawRequest = getRawMessageText(detail.rawRequest, detail.rawRequestHead, detail.requestBody);
    }

    if (!rawRequest && detail?.rawRequestDeferred) {
      detail = await ensureSessionDetailContent(queryClient, session.id, {
        includeRawRequest: true,
      });
      rawRequest = getRawMessageText(detail.rawRequest, detail.rawRequestHead, detail.requestBody);
    }

    if (!rawRequest) {
      return;
    }

    await copyToClipboard(rawRequest, t("contextMenu.copiedToClipboard"));
  }, [copyToClipboard, queryClient, t]);

  const handleCopyCurl = useCallback(async (session: SessionSummary) => {
    const detail = await ensureSessionDetailContent(queryClient, session.id, {
      includeRequestBodyText: true,
    });

    if (!detail) {
      return;
    }

    await copyToClipboard(buildCurlCommand(detail), t("composePage.copiedCurl"));
  }, [copyToClipboard, queryClient, t]);

  const handleCopyResponse = useCallback(async (session: SessionSummary) => {
    let detail = await ensureSessionDetailContent(queryClient, session.id, {});
    let rawResponse = getRawMessageText(detail?.rawResponse, detail?.rawResponseHead, detail?.responseBody);

    if (!rawResponse && detail?.responseBody?.textDeferred && detail.rawResponseHead) {
      detail = await ensureSessionDetailContent(queryClient, session.id, {
        includeResponseBodyText: true,
      });
      rawResponse = getRawMessageText(detail.rawResponse, detail.rawResponseHead, detail.responseBody);
    }

    if (!rawResponse && detail?.rawResponseDeferred) {
      detail = await ensureSessionDetailContent(queryClient, session.id, {
        includeRawResponse: true,
      });
      rawResponse = getRawMessageText(detail.rawResponse, detail.rawResponseHead, detail.responseBody);
    }

    if (!rawResponse) {
      return;
    }

    await copyToClipboard(rawResponse, t("contextMenu.copiedToClipboard"));
  }, [copyToClipboard, queryClient, t]);

  const handleSaveResponse = useCallback(async (session: SessionSummary) => {
    const detail = await ensureSessionDetailContent(queryClient, session.id, {
      includeResponseBodyText: true,
    });
    const bodyText = getBodyText(detail?.responseBody);

    if (!bodyText) {
      return;
    }

    const mimeType = detail?.responseBody?.mimeType ?? "application/octet-stream";
    const extension = guessExtension(mimeType);
    const filename = `${session.host.replace(/[^a-zA-Z0-9.-]/g, "_")}-${session.id.slice(0, 8)}.${extension}`;
    downloadTextFile(filename, bodyText, mimeType);
  }, [queryClient]);

  const handleCompose = useCallback(async (session: SessionSummary) => {
    const detail = await ensureSessionDetailContent(queryClient, session.id, {
      includeRequestBodyText: true,
    });
    const bodyText = detail?.requestBody?.inlineText;

    loadFromSession({
      method: session.method,
      url: session.url,
      headers: detail?.requestHeaders ?? [],
      ...(bodyText ? { body: bodyText } : {}),
    });
    navigate("/compose");
  }, [loadFromSession, navigate, queryClient]);

  const handleRepeatDirect = useCallback(async (session: SessionSummary) => {
    const detail = await ensureSessionDetailContent(queryClient, session.id, {
      includeRequestBodyText: true,
    });

    if (!detail) {
      return;
    }

    const bodyText = detail.requestBody?.inlineText;

    try {
      await sendComposedRequest.mutateAsync({
        workspaceId: "default",
        method: session.method,
        url: session.url,
        headers: detail.requestHeaders.map((header) => ({
          name: header.name,
          value: header.value,
        })),
        ...(bodyText ? { body: bodyText } : {}),
      });
    } catch {
      // Silent fail; the new session will appear via polling.
    }
  }, [queryClient, sendComposedRequest]);

  const handleFocusDomain = useCallback((host: string) => {
    setFocusedHosts((currentHosts) => {
      const nextHosts = new Set(currentHosts);

      if (nextHosts.has(host)) {
        nextHosts.delete(host);
      } else {
        nextHosts.add(host);
      }

      return nextHosts;
    });
  }, [setFocusedHosts]);

  const handleUnfocusDomain = useCallback((host: string) => {
    setFocusedHosts((currentHosts) => {
      if (!currentHosts.has(host)) {
        return currentHosts;
      }

      const nextHosts = new Set(currentHosts);
      nextHosts.delete(host);
      return nextHosts;
    });
  }, [setFocusedHosts]);

  const handleIgnoreDomain = useCallback((host: string) => {
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
  }, [setFocusedHosts, setIgnoredHosts]);

  const handleStopIgnoringDomain = useCallback((host: string) => {
    setIgnoredHosts((currentHosts) => {
      const nextHosts = new Set(currentHosts);
      nextHosts.delete(host);
      return nextHosts;
    });
  }, [setIgnoredHosts]);

  const handleFocusHost = useCallback((session: SessionSummary) => {
    handleFocusDomain(session.host);
  }, [handleFocusDomain]);

  const handleUnfocusHost = useCallback((session: SessionSummary) => {
    handleUnfocusDomain(session.host);
  }, [handleUnfocusDomain]);

  const handleIgnoreHost = useCallback((session: SessionSummary) => {
    handleIgnoreDomain(session.host);
  }, [handleIgnoreDomain]);

  const handleStopIgnoringHost = useCallback((session: SessionSummary) => {
    handleStopIgnoringDomain(session.host);
  }, [handleStopIgnoringDomain]);

  const handleSaveToCollection = useCallback((session: SessionSummary) => {
    setSaveToCollectionSession(session);
  }, []);

  const handleSaveToCollectionCancel = useCallback(() => {
    setSaveToCollectionSession(null);
  }, []);

  const handleSaveToCollectionConfirm = useCallback(async (collectionId: string, name?: string) => {
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
      showSnackbar("Failed to save");
    }
  }, [saveToCollectionSession, showSnackbar, t]);

  return {
    contextMenuAnchor,
    contextMenuHost,
    contextMenuSession,
    domainContextMenuAnchor,
    handleCompose,
    handleContextMenu,
    handleContextMenuClose,
    handleCopyCurl,
    handleCopyRequest,
    handleCopyResponse,
    handleCopyUrl,
    handleFocusDomain,
    handleFocusHost,
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
    handleStopIgnoringDomain,
    handleStopIgnoringHost,
    handleUnfocusDomain,
    handleUnfocusHost,
    saveToCollectionSession,
    snackbarMessage,
  };
}
