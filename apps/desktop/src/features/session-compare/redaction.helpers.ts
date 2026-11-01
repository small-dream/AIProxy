import type {
  SessionDiffEntry,
  SessionDiffPayload,
  SessionDiffSection,
} from "@aiproxy/shared-types";

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|set-cookie|token|access_token|refresh_token|api[-_]?key|password|passwd|secret|session|jwt)/i;
const REDACTED = "[REDACTED]";
// Query-parameter names are matched *exactly* (after lowercasing and dropping
// separators) instead of with the substring pattern above: the substring rule
// would turn `design=compact` into a redaction (it contains "sign") and
// `passwordless=true` into one too (it contains "password"), which would hide
// ordinary parameters from the diff. Normalized form: `access_token` →
// `accesstoken`, `X-Amz-Signature` → `xamzsignature`.
const SENSITIVE_QUERY_NAMES = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authkey",
  "authorization",
  "code",
  "cookie",
  "clientsecret",
  "csrf",
  "idtoken",
  "jwt",
  "password",
  "passwd",
  "pwd",
  "refreshtoken",
  "secret",
  "session",
  "sessionid",
  "setcookie",
  "sig",
  "sign",
  "signature",
  "token",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xapikey",
  "xauthkey",
  "xgoogsignature",
  "xsrf",
]);
// `scheme://user:password@host` — only the userinfo is masked, the rest of the
// string is left byte-for-byte intact.
const ABSOLUTE_URL_USERINFO_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#@]+)@/;
// `?name=value` / `&name=value` pairs. Deliberately not `new URL`: parsing would
// re-encode the untouched parts of the URL (`%20` → `+`, empty path → `/`).
const QUERY_PAIR_PATTERN = /([?&])([^=&#\s]+)=([^&#\s]*)/g;

export function redactDiffPayload(payload: SessionDiffPayload): SessionDiffPayload {
  return {
    ...payload,
    redacted: true,
    left: redactIdentity(payload.left),
    right: redactIdentity(payload.right),
    sections: payload.sections.map(redactSection),
  };
}

export function isSensitivePath(path: string) {
  return SENSITIVE_KEY_PATTERN.test(path);
}

/**
 * P1-3: mask credentials and sensitive query values inside a URL-shaped string.
 *
 * Section redaction below only looks at entry *names*, so the Summary `URL` row
 * and `left/right.url` used to send `?token=…`, `?code=…`, `?X-Amz-Signature=…`
 * to the AI provider in plaintext while the UI promised a redacted payload (and
 * the MCP side already redacts URL query values).
 *
 * String-level on purpose: `new URL` would re-encode the rest of the URL, and
 * the result has to stay readable in the preview the user reviews before
 * sending.
 */
export function redactUrlSecrets(value: string): string {
  return redactQueryValues(redactUserInfo(value));
}

function redactUserInfo(value: string): string {
  return value.replace(
    ABSOLUTE_URL_USERINFO_PATTERN,
    (_match, scheme: string) => `${scheme}${REDACTED}@`,
  );
}

function redactQueryValues(value: string): string {
  return value.replace(
    QUERY_PAIR_PATTERN,
    (match: string, separator: string, rawName: string, rawValue: string) => {
      if (!rawValue || !isSensitiveQueryName(rawName)) {
        return match;
      }

      return `${separator}${rawName}=${REDACTED}`;
    },
  );
}

function isSensitiveQueryName(rawName: string): boolean {
  return SENSITIVE_QUERY_NAMES.has(normalizeQueryName(decodeQueryComponent(rawName)));
}

function normalizeQueryName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function redactIdentity(identity: SessionDiffPayload["left"]): SessionDiffPayload["left"] {
  return {
    ...identity,
    // `label` is `${method} ${host}${path}` and live sessions keep the query in
    // `path`, so it needs the same masking as `url`.
    label: redactUrlSecrets(identity.label),
    url: redactUrlSecrets(identity.url),
  };
}

function redactSection(section: SessionDiffSection): SessionDiffSection {
  return {
    ...section,
    entries: section.entries.map(redactEntry),
  };
}

function redactEntry(entry: SessionDiffEntry): SessionDiffEntry {
  if (isSensitivePath(entry.path)) {
    return {
      ...entry,
      before: entry.before === undefined ? undefined : REDACTED,
      after: entry.after === undefined ? undefined : REDACTED,
    };
  }

  return {
    ...entry,
    before: entry.before === undefined ? undefined : redactUrlSecrets(entry.before),
    after: entry.after === undefined ? undefined : redactUrlSecrets(entry.after),
  };
}
