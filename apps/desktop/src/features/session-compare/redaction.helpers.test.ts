import { describe, expect, it } from "vitest";

import type { SessionDiffPayload } from "@aiproxy/shared-types";

import { redactDiffPayload, redactUrlSecrets } from "./redaction.helpers";

function buildPayload(): SessionDiffPayload {
  return {
    compareMode: "request",
    left: {
      id: "left-session",
      label: "POST api.example.com/v1/login?access_token=left-secret",
      method: "POST",
      url: "https://api.example.com/v1/login?access_token=left-secret&page=1",
      statusCode: 200,
      durationMs: 12,
      startedAt: "2026-11-01T00:00:00Z",
    },
    right: {
      id: "right-session",
      label: "POST api.example.com/v1/login?access_token=right-secret",
      method: "POST",
      url: "https://api.example.com/v1/login?access_token=right-secret&page=2",
      statusCode: 401,
      durationMs: 30,
      startedAt: "2026-11-01T00:01:00Z",
    },
    sections: [
      {
        key: "summary",
        title: "Summary",
        added: 0,
        removed: 0,
        changed: 2,
        unchanged: 5,
        entries: [
          {
            path: "URL",
            kind: "changed",
            before: "https://api.example.com/v1/login?sig=%2Fabc&page=1",
            after: "https://api.example.com/v1/login?sig=%2Fdef&page=2",
          },
          {
            path: "Status",
            kind: "changed",
            before: "200",
            after: "401",
          },
        ],
      },
      {
        key: "query",
        title: "Query",
        added: 0,
        removed: 0,
        changed: 1,
        unchanged: 1,
        entries: [
          { path: "access_token", kind: "changed", before: "left-secret", after: "right-secret" },
          { path: "page", kind: "changed", before: "1", after: "2" },
        ],
      },
      {
        key: "requestHeaders",
        title: "Request Headers",
        added: 0,
        removed: 0,
        changed: 1,
        unchanged: 0,
        entries: [
          {
            path: "Authorization",
            kind: "changed",
            before: "Bearer left-token",
            after: "Bearer right-token",
          },
        ],
      },
    ],
    redacted: false,
    bodyIncluded: false,
  };
}

describe("redactUrlSecrets", () => {
  it("masks sensitive query values but keeps the rest of the URL byte-for-byte", () => {
    expect(
      redactUrlSecrets(
        "https://api.example.com/v1/items?sort=%2Fabc&token=abc123&X-Amz-Signature=deadbeef&sig=12ab&page=2",
      ),
    ).toBe(
      "https://api.example.com/v1/items?sort=%2Fabc&token=[REDACTED]&X-Amz-Signature=[REDACTED]&sig=[REDACTED]&page=2",
    );
  });

  it("masks password/authorization/code style parameters case-insensitively", () => {
    expect(redactUrlSecrets("https://h/cb?Code=xyz&Password=pw&API_KEY=k")).toBe(
      "https://h/cb?Code=[REDACTED]&Password=[REDACTED]&API_KEY=[REDACTED]",
    );
  });

  it("masks userinfo credentials", () => {
    expect(redactUrlSecrets("https://alice:pw@example.com/path?page=1")).toBe(
      "https://[REDACTED]@example.com/path?page=1",
    );
  });

  it("leaves URLs without secrets untouched", () => {
    const url = "https://api.example.com/v1/items?page=2&sort=name";

    expect(redactUrlSecrets(url)).toBe(url);
  });

  it("does not treat unrelated parameter names as sensitive", () => {
    // Exact-name matching: `design` contains "sign" and `passwordless` contains
    // "password", but neither is a credential parameter.
    const url = "https://api.example.com/v1/items?design=compact&passwordless=true&status_code=200";

    expect(redactUrlSecrets(url)).toBe(url);
  });
});

describe("redactDiffPayload", () => {
  it("masks the identity URLs and labels, not just the section entries", () => {
    const payload = redactDiffPayload(buildPayload());

    expect(payload.redacted).toBe(true);
    expect(payload.left.url).toBe(
      "https://api.example.com/v1/login?access_token=[REDACTED]&page=1",
    );
    expect(payload.right.url).toBe(
      "https://api.example.com/v1/login?access_token=[REDACTED]&page=2",
    );
    expect(payload.left.label).toBe("POST api.example.com/v1/login?access_token=[REDACTED]");
    expect(payload.right.label).toBe("POST api.example.com/v1/login?access_token=[REDACTED]");
  });

  it("masks secrets embedded in non-sensitive entries such as the Summary URL row", () => {
    const payload = redactDiffPayload(buildPayload());
    const summary = payload.sections.find((section) => section.key === "summary");
    const urlEntry = summary?.entries.find((entry) => entry.path === "URL");

    expect(urlEntry?.before).toBe("https://api.example.com/v1/login?sig=[REDACTED]&page=1");
    expect(urlEntry?.after).toBe("https://api.example.com/v1/login?sig=[REDACTED]&page=2");
    const statusEntry = summary?.entries.find((entry) => entry.path === "Status");
    expect(statusEntry?.before).toBe("200");
    expect(statusEntry?.after).toBe("401");
  });
  it("keeps fully masking entries whose name is sensitive", () => {
    const payload = redactDiffPayload(buildPayload());
    const query = payload.sections.find((section) => section.key === "query");
    const tokenEntry = query?.entries.find((entry) => entry.path === "access_token");
    const headers = payload.sections.find((section) => section.key === "requestHeaders");

    expect(tokenEntry?.before).toBe("[REDACTED]");
    expect(tokenEntry?.after).toBe("[REDACTED]");
    expect(headers?.entries[0]?.before).toBe("[REDACTED]");
    expect(headers?.entries[0]?.after).toBe("[REDACTED]");
  });

  it("leaks no raw credential into the serialized payload", () => {
    const serialized = JSON.stringify(redactDiffPayload(buildPayload()));

    for (const secret of [
      "left-secret",
      "right-secret",
      "deadbeef",
      "left-token",
      "right-token",
      "alice",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // Non-sensitive values must survive so the diff stays useful.
    expect(serialized).toContain("page=1");
    expect(serialized).toContain("page=2");
  });
});
