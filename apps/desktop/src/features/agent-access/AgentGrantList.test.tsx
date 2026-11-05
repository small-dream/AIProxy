import { render, screen } from "@testing-library/react";
import type { AgentGrant, AgentAccessGrantList } from "@aiproxy/shared-types";
import { describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/app/providers/AppProviders";

import { AgentGrantList } from "./AgentGrantList";

function grant(overrides: Partial<AgentGrant>): AgentGrant {
  return {
    actionFingerprint: "sha256:a",
    actionSummary: "Read the response body",
    agentInstanceId: "mcp-test",
    approvalOption: "once",
    approvalOptions: ["once"],
    approvedAt: null,
    capability: "readBodies",
    clientName: "Codex",
    clientVersion: "1.0",
    createdAt: "2026-11-06T00:00:00Z",
    expiresAt: "2026-11-06T00:01:00Z",
    id: "grant-1",
    maxUses: 1,
    nonIdempotent: false,
    reason: "Inspect the response",
    remainingUses: 1,
    requestId: "grant-1",
    resourcePolicy: null,
    scope: {},
    status: "approved",
    ...overrides,
  };
}

function list(grants: AgentGrant[]): AgentAccessGrantList {
  return { grants, pendingCount: 0, storePath: "/tmp/agent-grants.json" };
}

describe("AgentGrantList", () => {
  it("shows unknown and denied history states with warnings", () => {
    render(
      <AppProviders>
        <AgentGrantList
          data={list([
            grant({ id: "unknown", requestId: "unknown", status: "unknown" }),
            grant({ id: "denied", requestId: "denied", status: "denied" }),
          ])}
          onRefresh={vi.fn()}
          onRevoke={vi.fn()}
        />
      </AppProviders>,
    );

    expect(screen.getByText("Result unknown")).toBeInTheDocument();
    expect(screen.getByText(/the action may already have run/i)).toBeInTheDocument();
    expect(screen.getByText("Denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });
});
