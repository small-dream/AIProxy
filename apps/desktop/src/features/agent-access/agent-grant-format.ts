import type { AgentCapability, AgentGrantScope } from "@aiproxy/shared-types";

import type { useI18n } from "@/i18n";

import { permissionDefinition } from "./agent-access.permissions";

export function grantCapabilityLabel(
  capability: AgentCapability,
  t: ReturnType<typeof useI18n>["t"],
) {
  return t(permissionDefinition(capability).labelKey);
}

export function grantScopeSummary(scope: AgentGrantScope, t: ReturnType<typeof useI18n>["t"]) {
  const parts: string[] = [];
  if (scope.methods?.length) parts.push(scope.methods.join(" / "));
  if (scope.host) parts.push(scope.host);
  if (scope.pathPrefix) parts.push(scope.pathPrefix);
  if (scope.workspaceId) {
    parts.push(t("settingsPage.agentAccess.grantScopeWorkspace", { workspace: scope.workspaceId }));
  }
  if (scope.sessionIds?.length) {
    parts.push(
      t("settingsPage.agentAccess.grantScopeSessions", { count: scope.sessionIds.length }),
    );
  }
  if (scope.origins?.length) {
    parts.push(t("settingsPage.agentAccess.grantScopeOrigins", { count: scope.origins.length }));
  }
  if (scope.automationRoots?.length) {
    parts.push(
      t("settingsPage.agentAccess.grantScopeRoots", { count: scope.automationRoots.length }),
    );
  }
  return parts.length > 0 ? parts.join(" · ") : t("settingsPage.agentAccess.grantScopeUnspecified");
}

export function grantStatusLabel(status: string, t: ReturnType<typeof useI18n>["t"]) {
  switch (status) {
    case "pending":
      return t("settingsPage.agentAccess.grantStatusPending");
    case "approved":
      return t("settingsPage.agentAccess.grantStatusApproved");
    case "executing":
      return t("settingsPage.agentAccess.grantStatusExecuting");
    case "succeeded":
      return t("settingsPage.agentAccess.grantStatusSucceeded");
    case "failed":
      return t("settingsPage.agentAccess.grantStatusFailed");
    case "unknown":
      return t("settingsPage.agentAccess.grantStatusUnknown");
    case "expired":
      return t("settingsPage.agentAccess.grantStatusExpired");
    case "revoked":
      return t("settingsPage.agentAccess.grantStatusRevoked");
    case "denied":
      return t("settingsPage.agentAccess.grantStatusDenied");
    case "cancelled":
      return t("settingsPage.agentAccess.grantStatusCancelled");
    default:
      return status;
  }
}
