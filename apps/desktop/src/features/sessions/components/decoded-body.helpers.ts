import type { ScriptDecodedBody } from "@aiproxy/shared-types";

import {
  LARGE_JSON_HARD_LIMIT,
  reindentJsonText,
  type JsonValue,
} from "./session-inspector.helpers";

export type DecodedBodyView =
  | { language: "json"; text: string; treeAvailable: boolean; value: JsonValue }
  | { language: "plain"; text: string };

function isJsonContainer(value: JsonValue): boolean {
  return value !== null && typeof value === "object";
}

/**
 * How the Decoded tab shows a decode hook's result. Objects the hook returned,
 * and strings that hold a JSON document, get the JSON tree / text views like
 * a JSON response; a truncated result is shown verbatim since its JSON is cut.
 */
export function resolveDecodedBodyView(decoded: ScriptDecodedBody): DecodedBodyView {
  if (!decoded.truncated) {
    try {
      const value = JSON.parse(decoded.text) as JsonValue;
      if (decoded.kind === "json" || isJsonContainer(value)) {
        return {
          language: "json",
          // Re-indent the original text: the tree shows parsed values, but
          // the text view and copy keep exact digits (64-bit IDs).
          text: reindentJsonText(decoded.text),
          treeAvailable: decoded.text.length <= LARGE_JSON_HARD_LIMIT,
          value,
        };
      }
    } catch {
      // Not JSON: fall through to plain text.
    }
  }

  return { language: "plain", text: decoded.text };
}
