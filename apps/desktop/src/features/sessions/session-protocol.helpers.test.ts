import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@aiproxy/shared-types";

import {
  formatSessionProtocol,
  getSessionProtocolMetadata,
  inferProtocolMetadata,
  isWebSocketSessionProtocol,
} from "./session-protocol.helpers";

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    method: "GET",
    host: "example.com",
    path: "/",
    protocol: "https",
    startedAt: "2026-04-19T00:00:00Z",
    finishedAt: "2026-04-19T00:00:01Z",
    durationMs: 1,
    sizeBytes: 10,
    statusCode: 200,
    url: "https://example.com/",
    ...overrides,
  };
}

describe("inferProtocolMetadata", () => {
  it("maps legacy http and https protocols to structured metadata", () => {
    expect(inferProtocolMetadata("http", "http://example.com/")).toEqual({
      scheme: "http",
      httpVersion: "1.1",
      transportProtocol: "tcp",
      applicationProtocol: "http",
    });
    expect(inferProtocolMetadata("https", "https://example.com/")).toEqual({
      scheme: "https",
      httpVersion: "1.1",
      transportProtocol: "tcp",
      applicationProtocol: "http",
    });
  });

  it("maps websocket protocols to websocket application metadata", () => {
    expect(inferProtocolMetadata("ws", "ws://example.com/socket")).toMatchObject({
      scheme: "http",
      applicationProtocol: "websocket",
    });
    expect(inferProtocolMetadata("wss", "wss://example.com/socket")).toMatchObject({
      scheme: "https",
      applicationProtocol: "websocket",
    });
  });

  it("recognizes h2 fallback values", () => {
    expect(inferProtocolMetadata("h2", "https://example.com/")).toEqual({
      scheme: "https",
      httpVersion: "2",
      transportProtocol: "tcp",
      applicationProtocol: "http",
    });
  });
});

describe("getSessionProtocolMetadata", () => {
  it("uses explicit session metadata before legacy fallback", () => {
    expect(getSessionProtocolMetadata(createSessionSummary({
      applicationProtocol: "grpc",
      httpVersion: "2",
      scheme: "https",
      transportProtocol: "tcp",
    }))).toEqual({
      scheme: "https",
      httpVersion: "2",
      transportProtocol: "tcp",
      applicationProtocol: "grpc",
    });
  });

  it("formats protocol labels from structured metadata", () => {
    expect(formatSessionProtocol(createSessionSummary())).toBe("HTTP/1.1");
    expect(formatSessionProtocol(createSessionSummary({
      applicationProtocol: "grpc",
      httpVersion: "2",
    }))).toBe("GRPC/2");
  });

  it("detects websocket sessions from new or legacy fields", () => {
    expect(isWebSocketSessionProtocol(createSessionSummary({ applicationProtocol: "websocket" }))).toBe(true);
    expect(isWebSocketSessionProtocol(createSessionSummary({ protocol: "wss" }))).toBe(true);
  });

  it("displays HTTP/2 for h2 session with structured metadata", () => {
    expect(formatSessionProtocol(createSessionSummary({ protocol: "h2", httpVersion: "2" }))).toBe("HTTP/2");
  });

  it("displays HTTP/2 with only httpVersion field", () => {
    expect(formatSessionProtocol(createSessionSummary({ protocol: "https", httpVersion: "2" }))).toBe("HTTP/2");
  });

  it("prefers explicit httpVersion over protocol inference", () => {
    const meta = getSessionProtocolMetadata(createSessionSummary({ protocol: "https", httpVersion: "2" }));
    expect(meta.httpVersion).toBe("2");
    expect(meta.scheme).toBe("https");
    expect(meta.transportProtocol).toBe("tcp");
    expect(meta.applicationProtocol).toBe("http");
  });
});
