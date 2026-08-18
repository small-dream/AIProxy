import { describe, expect, it } from "vitest";

import {
  getDnsMappingValidationErrors,
  getMapValidationErrors,
  getRewriteValidationErrors,
  getScriptValidationErrors,
  hasRuleFieldErrors,
  ruleFieldProps,
} from "./rules.helpers";

function makeT() {
  return (key: string) => key;
}

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

  it("validates the active rewrite payload only", () => {
    const errors = getRewriteValidationErrors(
      {
        id: "1",
        workspaceId: "default",
        name: "ok",
        enabled: true,
        priority: 100,
        match: { urlPattern: "example.com", methods: [], stage: "either" },
        rewriteType: "header",
        payload: { target: "request", operation: "set", headerName: "", value: "" },
        note: "",
      },
      t,
    );

    expect(errors["payload.headerName"]).toBe("rulesPage.validation.headerNameRequired");
    expect(errors["payload.value"]).toBe("rulesPage.validation.headerValueRequired");
    expect(errors["payload.paramName"]).toBeUndefined();
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
        payload: {
          target: "response",
          contentType: "application/json",
          mode: "fields",
          fields: [
            { operation: "set", path: "", value: "x", valueType: "string" },
            { operation: "set", path: "a.b", value: "", valueType: "string" },
          ],
        },
        note: "",
      },
      t,
    );

    expect(errors["payload.fields.0.path"]).toBe("rulesPage.validation.bodyFieldPathRequired");
    expect(errors["payload.fields.1.value"]).toBe("rulesPage.validation.bodyFieldValueRequired");
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
        payload: { targetUrl: "https://example.com", preservePath: true, preserveQuery: true },
        note: "",
      },
      t,
    );

    expect(errors["match.urlPattern"]).toBe("rulesPage.validation.regexPatternInvalid");
  });
});
