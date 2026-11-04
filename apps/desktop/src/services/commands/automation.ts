import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  type AutomationApplyResult,
  type AutomationChangeView,
  type ClearAgentAutomationInput,
  type ClearAgentAutomationResult,
  type RollbackAutomationChangeInput,
} from "@aiproxy/shared-types";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

export async function listAutomationChanges(limit = 20): Promise<AutomationChangeView[]> {
  if (!isTauriRuntime()) return [];
  try {
    return await invoke<AutomationChangeView[]>("list_automation_changes", { limit });
  } catch (error) {
    reportCommandFailure("list_automation_changes", error);
    throw coerceAppError(error);
  }
}

export async function getAutomationChange(changeId: string): Promise<AutomationChangeView> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Automation experiment details require the desktop runtime.");
  }
  try {
    return await invoke<AutomationChangeView>("get_automation_change", { changeId });
  } catch (error) {
    reportCommandFailure("get_automation_change", error, { changeId });
    throw coerceAppError(error);
  }
}

export async function rollbackAutomationChange(
  input: RollbackAutomationChangeInput,
): Promise<AutomationApplyResult> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Automation rollback requires the desktop runtime.");
  }
  try {
    return await invoke<AutomationApplyResult>("rollback_automation_change", { input });
  } catch (error) {
    reportCommandFailure("rollback_automation_change", error, { changeId: input.changeId });
    throw coerceAppError(error);
  }
}

export async function promoteAutomationChange(changeId: string): Promise<AutomationChangeView> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Automation promotion requires the desktop runtime.");
  }
  try {
    return await invoke<AutomationChangeView>("promote_automation_change", { changeId });
  } catch (error) {
    reportCommandFailure("promote_automation_change", error, { changeId });
    throw coerceAppError(error);
  }
}

export async function clearAgentAutomation(
  input: ClearAgentAutomationInput,
): Promise<ClearAgentAutomationResult> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Automation cleanup requires the desktop runtime.");
  }
  try {
    return await invoke<ClearAgentAutomationResult>("clear_agent_automation", {
      scope: input.scope,
      workspaceId: input.workspaceId,
      lifecycle: input.lifecycle,
    });
  } catch (error) {
    reportCommandFailure("clear_agent_automation", error, { scope: input.scope });
    throw coerceAppError(error);
  }
}
