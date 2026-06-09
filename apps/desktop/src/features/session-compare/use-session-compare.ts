import {
  coerceAppError,
  type CompareAiPayload,
  type CompareMode,
  type SessionDetail,
  type SessionSummary,
} from "@aiproxy/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { buildSessionDiffPayload } from "@/features/session-compare/session-diff.helpers";
import {
  buildSessionComparePayload,
  getAvailableDomains,
  type SessionCompareScopeInput,
} from "@/features/session-compare/session-behavior-diff.helpers";
import { ensureSessionDetailContent } from "@/features/sessions/session-detail-content";
import {
  type SessionCompareScope,
  useSessionCompareScopes,
} from "@/features/sessions/session-scope-registry";
import { useSessions } from "@/features/sessions/use-sessions";
import { useI18n } from "@/i18n";
import { getAiSettings, summarizeSessionDiff } from "@/services/commands";

// --- Constants ---

export const BODY_DIFF_DISPLAY_ENTRY_LIMIT = 240;
export const DIFF_SECTION_VISIBLE_CHANGE_LIMIT = 120;
export const LAZY_BODY_DIFF_SECTIONS = new Set(["requestBody", "responseBody"]);
export const SESSION_TABLE_LIMIT = 80;
export const SEQUENCE_PREVIEW_LIMIT = 36;

// --- Types ---

export type DetailState = {
  left?: SessionDetail;
  right?: SessionDetail;
  loading: boolean;
  error?: string | undefined;
};

// --- Hook ---

export function useSessionCompare() {
  const { locale, t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const {
    data: sessions = [],
    isLoading: sessionsLoading,
    isError: isSessionsError,
  } = useSessions();

  const scopes = useSessionCompareScopes();

  // --- Selection state (synced with URL) ---

  const [compareMode, setCompareMode] = useState<CompareMode>(readCompareMode(searchParams));
  const [leftId, setLeftId] = useState(searchParams.get("left") ?? "");
  const [rightId, setRightId] = useState(searchParams.get("right") ?? "");
  const [leftScopeId, setLeftScopeId] = useState(searchParams.get("leftScope") ?? "");
  const [rightScopeId, setRightScopeId] = useState(searchParams.get("rightScope") ?? "");
  const [domainFilter, setDomainFilter] = useState<string[]>(readDomains(searchParams));
  const [includeBodyForAi, setIncludeBodyForAi] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detailState, setDetailState] = useState<DetailState>({ loading: false });
  const [expandedBodySections, setExpandedBodySections] = useState<Set<string>>(() => new Set());
  const [expandedEntrySections, setExpandedEntrySections] = useState<Set<string>>(() => new Set());
  const previousCompareKeyRef = useRef("");

  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: getAiSettings,
  });

  const summaryMutation = useMutation({
    mutationFn: (payload: CompareAiPayload) =>
      summarizeSessionDiff({
        language: locale,
        payload,
      }),
  });

  // --- Sync state from URL ---

  useEffect(() => {
    setCompareMode(readCompareMode(searchParams));
    setLeftId(searchParams.get("left") ?? "");
    setRightId(searchParams.get("right") ?? "");
    setLeftScopeId(searchParams.get("leftScope") ?? "");
    setRightScopeId(searchParams.get("rightScope") ?? "");
    setDomainFilter(readDomains(searchParams));
  }, [searchParams]);

  // --- Load detail when request mode selected ---

  useEffect(() => {
    if (compareMode !== "request" || !leftId || !rightId || leftId === rightId) {
      setDetailState({ loading: false });
      return;
    }

    let cancelled = false;
    setDetailState((current) => ({ ...current, loading: true, error: undefined }));
    void Promise.all([
      ensureSessionDetailContent(queryClient, leftId, {
        includeRequestBodyText: true,
        includeResponseBodyText: true,
      }),
      ensureSessionDetailContent(queryClient, rightId, {
        includeRequestBodyText: true,
        includeResponseBodyText: true,
      }),
    ]).then(
      ([left, right]) => {
        if (!cancelled) {
          setDetailState({ left, right, loading: false });
        }
      },
      (error) => {
        if (!cancelled) {
          setDetailState({
            loading: false,
            error: coerceAppError(error).message || t("comparePage.detailLoadError"),
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [compareMode, leftId, queryClient, rightId, t]);

  // --- Computed ---

  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );

  const scopeOptions = useMemo(
    () => scopes.map((scope) => resolveScope(scope, sessionById)),
    [scopes, sessionById],
  );

  const selectedLeft = useMemo(
    () => sessions.find((session) => session.id === leftId),
    [leftId, sessions],
  );

  const selectedRight = useMemo(
    () => sessions.find((session) => session.id === rightId),
    [rightId, sessions],
  );

  const selectedLeftScope = useMemo(
    () => scopeOptions.find((scope) => scope.id === leftScopeId),
    [leftScopeId, scopeOptions],
  );

  const selectedRightScope = useMemo(
    () => scopeOptions.find((scope) => scope.id === rightScopeId),
    [rightScopeId, scopeOptions],
  );

  const domainOptions = useMemo(
    () =>
      getAvailableDomains(selectedLeftScope?.sessions ?? [], selectedRightScope?.sessions ?? []),
    [selectedLeftScope?.sessions, selectedRightScope?.sessions],
  );

  const effectiveDomainFilter = useMemo(
    () => domainFilter.filter((domain) => domainOptions.includes(domain)),
    [domainFilter, domainOptions],
  );

  // Reset summary when comparison key changes

  useEffect(() => {
    const compareKey = `${compareMode}:${leftId}:${rightId}:${leftScopeId}:${rightScopeId}:${effectiveDomainFilter.join(",")}:${includeBodyForAi}`;
    if (previousCompareKeyRef.current === compareKey) {
      return;
    }
    previousCompareKeyRef.current = compareKey;
    summaryMutation.reset();
    setExpandedBodySections(new Set());
    setExpandedEntrySections(new Set());
  }, [compareMode, effectiveDomainFilter, includeBodyForAi, leftId, leftScopeId, rightId, rightScopeId, summaryMutation]);

  // --- Diff payloads ---

  const requestDisplayPayload = useMemo(() => {
    if (compareMode !== "request" || !detailState.left || !detailState.right) {
      return undefined;
    }
    return buildSessionDiffPayload(detailState.left, detailState.right, {
      bodyDiffMode: "summary",
      expandedBodySections,
      includeBodyForAi,
      maxBodyEntries: BODY_DIFF_DISPLAY_ENTRY_LIMIT,
      redact: true,
    });
  }, [compareMode, detailState.left, detailState.right, expandedBodySections, includeBodyForAi]);

  const sessionPayload = useMemo(() => {
    if (
      compareMode !== "session" ||
      !selectedLeftScope ||
      !selectedRightScope ||
      selectedLeftScope.id === selectedRightScope.id
    ) {
      return undefined;
    }
    return buildSessionComparePayload(selectedLeftScope, selectedRightScope, effectiveDomainFilter);
  }, [compareMode, effectiveDomainFilter, selectedLeftScope, selectedRightScope]);

  const displayPayload = compareMode === "request" ? requestDisplayPayload : sessionPayload;
  const aiSettings = aiSettingsQuery.data;
  const aiConfigured = Boolean(aiSettings?.hasApiKey && aiSettings.model.trim());
  const canGenerate = Boolean(displayPayload && aiConfigured && !detailState.loading);

  const previewPayload = previewOpen ? buildAiPayload() : undefined;
  const previewText = previewPayload ? JSON.stringify(previewPayload, null, 2) : "";

  const isSameSelection =
    compareMode === "request"
      ? Boolean(leftId && rightId && leftId === rightId)
      : Boolean(leftScopeId && rightScopeId && leftScopeId === rightScopeId);

  // --- Actions ---

  function buildAiPayload(): CompareAiPayload | undefined {
    if (compareMode === "session") {
      return sessionPayload;
    }
    if (!detailState.left || !detailState.right) {
      return undefined;
    }
    return buildSessionDiffPayload(detailState.left, detailState.right, {
      bodyDiffMode: "diff",
      includeBodyForAi,
      redact: true,
    });
  }

  function updateMode(nextMode: CompareMode) {
    setCompareMode(nextMode);
    const params = new URLSearchParams(searchParams);
    params.set("mode", nextMode);
    setSearchParams(params);
  }

  function updateRequestSelection(nextLeft: string, nextRight: string) {
    setLeftId(nextLeft);
    setRightId(nextRight);
    const params = new URLSearchParams(searchParams);
    params.set("mode", "request");
    if (nextLeft) params.set("left", nextLeft);
    else params.delete("left");
    if (nextRight) params.set("right", nextRight);
    else params.delete("right");
    setSearchParams(params);
  }

  function updateScopeSelection(nextLeftScope: string, nextRightScope: string) {
    setLeftScopeId(nextLeftScope);
    setRightScopeId(nextRightScope);
    const params = new URLSearchParams(searchParams);
    params.set("mode", "session");
    if (nextLeftScope) params.set("leftScope", nextLeftScope);
    else params.delete("leftScope");
    if (nextRightScope) params.set("rightScope", nextRightScope);
    else params.delete("rightScope");
    setSearchParams(params);
  }

  function updateDomainFilter(nextDomains: string[]) {
    const normalizedDomains = nextDomains.filter((domain) => domainOptions.includes(domain));
    setDomainFilter(normalizedDomains);
    const params = new URLSearchParams(searchParams);
    params.set("mode", "session");
    if (normalizedDomains.length > 0) {
      params.set("domains", normalizedDomains.join(","));
    } else {
      params.delete("domains");
    }
    setSearchParams(params);
  }

  function toggleBodySection(sectionKey: string) {
    setExpandedBodySections((current) => {
      const next = new Set(current);
      if (next.has(sectionKey)) {
        next.delete(sectionKey);
      } else {
        next.add(sectionKey);
      }
      return next;
    });
  }

  function toggleEntrySection(sectionKey: string) {
    setExpandedEntrySections((current) => {
      const next = new Set(current);
      if (next.has(sectionKey)) {
        next.delete(sectionKey);
      } else {
        next.add(sectionKey);
      }
      return next;
    });
  }

  function handleGenerateSummary() {
    const aiPayload = buildAiPayload();
    if (aiPayload) {
      summaryMutation.mutate(aiPayload);
    }
  }

  return {
    // Data
    sessions,
    sessionsLoading,
    isSessionsError,
    scopeOptions,

    // Selection state
    compareMode,
    leftId,
    rightId,
    leftScopeId,
    rightScopeId,
    effectiveDomainFilter,
    domainOptions,
    includeBodyForAi,
    previewOpen,
    detailState,

    // Expanded state
    expandedBodySections,
    expandedEntrySections,

    // Computed
    selectedLeft,
    selectedRight,
    requestDisplayPayload,
    sessionPayload,
    displayPayload,
    previewText,
    isSameSelection,

    // AI
    aiSettings,
    aiConfigured,
    canGenerate,
    summaryMutation,

    // Actions
    updateMode,
    updateRequestSelection,
    updateScopeSelection,
    updateDomainFilter,
    setIncludeBodyForAi,
    setPreviewOpen,
    toggleBodySection,
    toggleEntrySection,
    handleGenerateSummary,

    // i18n
    t,
  };
}

// --- Helper functions ---

function resolveScope(
  scope: SessionCompareScope,
  sessionById: Map<string, SessionSummary>,
): SessionCompareScopeInput {
  return {
    id: scope.id,
    label: scope.label,
    sessions: scope.sessionIds
      .map((sessionId) => sessionById.get(sessionId))
      .filter((session): session is SessionSummary => Boolean(session)),
  };
}

export function readCompareMode(searchParams: URLSearchParams): CompareMode {
  return searchParams.get("mode") === "session" ? "session" : "request";
}

function readDomains(searchParams: URLSearchParams) {
  return (searchParams.get("domains") ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}
