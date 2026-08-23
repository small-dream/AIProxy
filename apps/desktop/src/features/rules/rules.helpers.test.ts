import { describe, expect, it } from "vitest";
import type { MapRule, RewriteRule } from "@aiproxy/shared-types";

import {
  getDnsMappingValidationErrors,
  getMapValidationErrors,
  getRewriteValidationErrors,
  getScriptValidationErrors,
  hasRuleFieldErrors,
  isMapRuleEqual,
  isRewriteRuleEqual,
  ruleFieldProps,
} from "./rules.helpers";

function makeT() {
  return (key: string) => key;
}

function makeMapRule(overrides: Partial<MapRule> = {}): MapRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: "default",
    mode: "remote",
    name: "rule",
    note: "",
    enabled: true,
    priority: 100,
    sourcePattern: "example.com",
    targetValue: "https://other.com",
    preservePath: true,
    preserveQuery: true,
    ...overrides,
  };
}

function makeRewriteRule(overrides: Partial<RewriteRule> = {}): RewriteRule {
  return {
    id: crypto.randomUUID(),
    workspaceId: "default",
    name: "rule",
    note: "",
    enabled: true,
    priority: 100,
    match: { urlPattern: "example.com", methods: ["GET"], stage: "either" },
    rewriteType: "header",
    actions: [
      {
        rewriteType: "header",
        payload: { headerName: "x-a", operation: "set", target: "request", value: "1" },
      },
    ],
    ...overrides,
  };
}

describe("isRewriteRuleEqual — rewrite editor dirty check (P0-2)", () => {
  it("considers identical rules equal", () => {
    const rule = makeRewriteRule();
    expect(isRewriteRuleEqual(rule, structuredClone(rule))).toBe(true);
  });

  it("ignores the id so an unsaved draft compares against a fresh baseline", () => {
    const rule = makeRewriteRule();
    expect(isRewriteRuleEqual(rule, makeRewriteRule({ ...rule, id: crypto.randomUUID() }))).toBe(
      true,
    );
  });

  it("normalizes optional fields to their editor-form defaults", () => {
    const rule = makeRewriteRule();
    // note: absent vs "" and matchType unset vs explicit default must not
    // read as dirty.
    const withoutNote = structuredClone(rule);
    delete (withoutNote as Partial<RewriteRule>).note;
    expect(isRewriteRuleEqual(rule, withoutNote as RewriteRule)).toBe(true);

    const withMatchType = makeRewriteRule({
      match: {
        urlPattern: "example.com",
        methods: ["GET"],
        stage: "either",
        matchType: "contains",
      },
    });
    expect(isRewriteRuleEqual(rule, withMatchType)).toBe(true);
  });

  it("detects scalar field edits", () => {
    const rule = makeRewriteRule();
    expect(isRewriteRuleEqual(rule, makeRewriteRule({ name: "renamed" }))).toBe(false);
    expect(isRewriteRuleEqual(rule, makeRewriteRule({ enabled: false }))).toBe(false);
    expect(isRewriteRuleEqual(rule, makeRewriteRule({ priority: 200 }))).toBe(false);
    expect(
      isRewriteRuleEqual(
        rule,
        makeRewriteRule({
          match: { urlPattern: "other.com", methods: ["GET"], stage: "either" },
        }),
      ),
    ).toBe(false);
    expect(
      isRewriteRuleEqual(
        rule,
        makeRewriteRule({
          match: {
            urlPattern: "example.com",
            methods: ["GET"],
            stage: "either",
            matchType: "wildcard",
          },
        }),
      ),
    ).toBe(false);
  });

  it("deep-compares actions regardless of payload key order", () => {
    const rule = makeRewriteRule();
    const reorderedPayload = makeRewriteRule({
      actions: [
        {
          rewriteType: "header",
          payload: { value: "1", target: "request", operation: "set", headerName: "x-a" },
        },
      ],
    });
    expect(isRewriteRuleEqual(rule, reorderedPayload)).toBe(true);

    expect(
      isRewriteRuleEqual(
        rule,
        makeRewriteRule({
          actions: [
            {
              rewriteType: "header",
              payload: { headerName: "x-a", operation: "set", target: "request", value: "2" },
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("treats method list order as significant and detects action count changes", () => {
    const rule = makeRewriteRule();
    expect(
      isRewriteRuleEqual(
        rule,
        makeRewriteRule({ match: { urlPattern: "example.com", methods: [], stage: "either" } }),
      ),
    ).toBe(false);

    const twoActions = makeRewriteRule({
      actions: [
        ...rule.actions,
        { rewriteType: "query", payload: { operation: "set", paramName: "p", value: "v" } },
      ],
    });
    expect(isRewriteRuleEqual(rule, twoActions)).toBe(false);
  });
});

describe("isMapRuleEqual — map editor dirty check (P0-2)", () => {
  it("considers identical rules equal and ignores the id", () => {
    const rule = makeMapRule();
    expect(isMapRuleEqual(rule, structuredClone(rule))).toBe(true);
    expect(isMapRuleEqual(rule, makeMapRule({ ...rule, id: crypto.randomUUID() }))).toBe(true);
  });

  it("normalizes matchType: unset compares as the explicit contains default", () => {
    const rule = makeMapRule();
    expect(isMapRuleEqual(rule, makeMapRule({ matchType: "contains" }))).toBe(true);
  });

  it("detects a matchType-only edit so switching tabs cannot silently drop it", () => {
    const rule = makeMapRule();
    expect(isMapRuleEqual(rule, makeMapRule({ matchType: "wildcard" }))).toBe(false);
    expect(isMapRuleEqual(rule, makeMapRule({ matchType: "exact" }))).toBe(false);
    expect(isMapRuleEqual(rule, makeMapRule({ matchType: "regex" }))).toBe(false);
  });

  it("detects scalar field edits", () => {
    const rule = makeMapRule();
    expect(isMapRuleEqual(rule, makeMapRule({ name: "renamed" }))).toBe(false);
    expect(isMapRuleEqual(rule, makeMapRule({ enabled: false }))).toBe(false);
    expect(isMapRuleEqual(rule, makeMapRule({ preserveQuery: false }))).toBe(false);
  });
});

describe("ruleFieldProps", () => {
  it("returns no error before validation is attempted", () => {
    expect(ruleFieldProps({ name: "required" }, false, "name")).toEqual({ error: false });
  });

  it("surfaces the field message once validation is attempted", () => {
    expect(ruleFieldProps({ name: "required" }, true, "name")).toEqual({
      error: true,
      helperText: "required",
    });
  });

  it("ignores errors for unrelated keys", () => {
    expect(ruleFieldProps({ name: "required" }, true, "sourcePattern")).toEqual({
      error: false,
    });
  });
});

describe("hasRuleFieldErrors", () => {
  it("is false for an empty map", () => {
    expect(hasRuleFieldErrors({})).toBe(false);
  });

  it("is true when any field carries a message", () => {
    expect(hasRuleFieldErrors({ name: "required" })).toBe(true);
  });
});

describe("map rule validation", () => {
  const t = makeT();

  it("keys errors by field name", () => {
    const errors = getMapValidationErrors(
      {
        id: "1",
        workspaceId: "default",
        mode: "remote",
        name: "",
        enabled: true,
        priority: 100,
        sourcePattern: "",
        targetValue: "not-a-url",
        preservePath: true,
        preserveQuery: true,
        note: "",
      },
      t,
    );

    expect(errors).toEqual({
      name: "rulesPage.validation.ruleNameRequired",
      sourcePattern: "rulesPage.validation.mapSourceRequired",
      targetValue: "rulesPage.validation.remoteTargetInvalid",
    });
  });

  it("uses the local-target message for local maps", () => {
    const errors = getMapValidationErrors(
      {
        id: "1",
        workspaceId: "default",
        mode: "local",
        name: "ok",
        enabled: true,
        priority: 100,
        sourcePattern: "example.com",
        targetValue: "",
        preservePath: true,
        preserveQuery: true,
        note: "",
      },
      t,
    );

    expect(errors.targetValue).toBe("rulesPage.validation.localTargetRequired");
  });
});

describe("dns mapping validation", () => {
  const t = makeT();

  it("reports invalid IPs on the targetIp key", () => {
    const errors = getDnsMappingValidationErrors(
      {
        id: "1",
        workspaceId: "default",
        name: "ok",
        enabled: true,
        priority: 100,
        hostPattern: "example.com",
        targetIp: "999.1.1.1",
        note: "",
      },
      t,
    );

    expect(errors.targetIp).toBe("rulesPage.validation.dnsTargetIpInvalid");
    expect(errors.name).toBeUndefined();
  });
});

describe("script rule validation", () => {
  const t = makeT();

  it("keys nested match and source errors", () => {
    const errors = getScriptValidationErrors(
      {
        id: "1",
        workspaceId: "default",
        name: "",
        enabled: true,
        entrypoints: { onRequest: true, onResponse: false },
        priority: 100,
        match: { urlPattern: "", methods: [], stage: "either" },
        language: "typescript",
        sourceCode: "",
        sourceType: "inline",
        note: "",
      },
      t,
    );

    expect(errors["match.urlPattern"]).toBe("rulesPage.validation.urlPatternRequired");
    expect(errors.sourceCode).toBe("rulesPage.validation.scriptSourceRequired");
  });
});

describe("rewrite rule validation", () => {
  const t = makeT();

  it("validates each action payload under its actions.<i>.payload key", () => {
    const errors = getRewriteValidationErrors(
      {
        id: "1",
        workspaceId: "default",
        name: "ok",
        enabled: true,
        priority: 100,
        match: { urlPattern: "example.com", methods: [], stage: "either" },
        rewriteType: "header",
        actions: [
          {
            rewriteType: "header",
            payload: { target: "request", operation: "set", headerName: "", value: "" },
          },
          {
            rewriteType: "query",
            payload: { operation: "set", paramName: "env", value: "staging" },
          },
        ],
        note: "",
      },
      t,
    );

    expect(errors["actions.0.payload.headerName"]).toBe("rulesPage.validation.headerNameRequired");
    expect(errors["actions.0.payload.value"]).toBe("rulesPage.validation.headerValueRequired");
    expect(errors["actions.1.payload.paramName"]).toBeUndefined();
  });

  it("flags per-row body field errors with their index", () => {
    const errors = getRewriteValidationErrors(
      {
        id: "1",
        workspaceId: "default",
        name: "ok",
        enabled: true,
        priority: 100,
        match: { urlPattern: "example.com", methods: [], stage: "either" },
        rewriteType: "body",
        actions: [
          {
            rewriteType: "body",
            payload: {
              target: "response",
              contentType: "application/json",
              mode: "fields",
              fields: [
                { operation: "set", path: "", value: "x", valueType: "string" },
                { operation: "set", path: "a.b", value: "", valueType: "string" },
              ],
            },
          },
        ],
        note: "",
      },
      t,
    );

    expect(errors["actions.0.payload.fields.0.path"]).toBe(
      "rulesPage.validation.bodyFieldPathRequired",
    );
    expect(errors["actions.0.payload.fields.1.value"]).toBe(
      "rulesPage.validation.bodyFieldValueRequired",
    );
  });

  it("flags an invalid regex on the match.urlPattern key", () => {
    const errors = getRewriteValidationErrors(
      {
        id: "1",
        workspaceId: "default",
        name: "ok",
        enabled: true,
        priority: 100,
        match: { urlPattern: "([", methods: [], stage: "either", matchType: "regex" },
        rewriteType: "redirect",
        actions: [
          {
            rewriteType: "redirect",
            payload: {
              targetUrl: "https://example.com",
              preservePath: true,
              preserveQuery: true,
            },
          },
        ],
        note: "",
      },
      t,
    );

    expect(errors["match.urlPattern"]).toBe("rulesPage.validation.regexPatternInvalid");
  });

  it("requires at least one action", () => {
    const errors = getRewriteValidationErrors(
      {
        id: "1",
        workspaceId: "default",
        name: "ok",
        enabled: true,
        priority: 100,
        match: { urlPattern: "example.com", methods: [], stage: "either" },
        rewriteType: "header",
        actions: [],
        note: "",
      },
      t,
    );

    expect(errors.actions).toBe("rulesPage.rewrite.actionsRequired");
  });
});
