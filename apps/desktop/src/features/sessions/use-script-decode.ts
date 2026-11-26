import type { ScriptDecodeResult, SessionSummary } from "@aiproxy/shared-types";
import { useQuery } from "@tanstack/react-query";

import { decodeSessionBody, findScriptDecoders } from "@/services/commands";
import { getImportedSessionDetail } from "./imported-sessions.store";
import { type DecodedBodyView, resolveDecodedBodyView } from "./components/decoded-body.helpers";
import { isWebSocketSession } from "./components/session-inspector.helpers";

export type DecodeStage = "request" | "response";

export type ScriptDecodeData = {
  result: ScriptDecodeResult;
  /** Display form of `result.decoded`, computed once per decode (up to 8 MB). */
  view: DecodedBodyView | null;
};

// Both keys share the rules center's ["script-rules"] prefix, so saving or
// toggling a script rule (which invalidates that prefix) re-resolves decoders
// and re-runs open decodes with the new code.
const SCRIPT_DECODERS_KEY = ["script-rules", "session-decoders"] as const;
const SCRIPT_DECODE_KEY = ["script-rules", "session-decode"] as const;

/** Which script rule (if any) can decode this session's request / response. */
export function useScriptDecoders(session: SessionSummary) {
  // Imported sessions are not in the backend store, so there is nothing to
  // decode against; WebSocket sessions have no single body.
  const decodable = !getImportedSessionDetail(session.id) && !isWebSocketSession(session);
  return useQuery({
    enabled: decodable,
    queryFn: () => findScriptDecoders(session.method, session.url),
    queryKey: [...SCRIPT_DECODERS_KEY, session.method, session.url],
    // Matching is an in-memory lookup; re-check on every mount so switching
    // the proxy's workspace is picked up without tracking it here.
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}

/**
 * Run the decode hook for one stage of a session; cached until rules change.
 * `decoderRuleId` is part of the key so a different matching rule (another
 * workspace, a reprioritized rule) decodes again instead of reusing a result.
 */
export function useScriptDecode(
  session: SessionSummary,
  stage: DecodeStage,
  decoderRuleId: string | null,
) {
  return useQuery({
    enabled: decoderRuleId !== null,
    queryFn: async (): Promise<ScriptDecodeData | null> => {
      const result = await decodeSessionBody(session.id, stage);
      if (!result) return null;
      return { result, view: result.decoded ? resolveDecodedBodyView(result.decoded) : null };
    },
    // finishedAt: an in-flight session is decoded again once it completes.
    queryKey: [...SCRIPT_DECODE_KEY, session.id, stage, session.finishedAt, decoderRuleId],
    retry: false,
    staleTime: Infinity,
  });
}
