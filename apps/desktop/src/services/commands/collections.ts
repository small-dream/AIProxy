import { invoke } from "@tauri-apps/api/core";

import {
  coerceAppError,
  parseSessionDetail,
  parseApiCollections,
  parseApiCollectionItem,
  parseApiCollectionItems,
  type SessionDetail,
  type ApiCollection,
  type ApiCollectionItem,
  type CollectionSaveInput,
  type SessionToCollectionInput,
  type BatchExecuteInput,
} from "@aiproxy/shared-types";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

export async function listApiCollections(): Promise<ApiCollection[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  try {
    const payload = await invoke<unknown>("list_api_collections");
    return parseApiCollections(payload);
  } catch (error) {
    reportCommandFailure("list_api_collections", error);
    throw coerceAppError(error);
  }
}

export async function upsertApiCollection(input: {
  id?: string;
  parentId?: string | null;
  name: string;
  description?: string;
  sortOrder?: number;
}): Promise<ApiCollection> {
  if (!isTauriRuntime()) {
    return {
      id: input.id ?? crypto.randomUUID(),
      parentId: input.parentId ?? null,
      name: input.name,
      description: input.description ?? "",
      sortOrder: input.sortOrder ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const payload = await invoke<unknown>("upsert_api_collection", {
      input: { ...input, parentId: input.parentId ?? null },
    });
    const collections = parseApiCollections([payload]);
    const result = collections[0];
    if (!result) throw coerceAppError("Empty response");
    return result;
  } catch (error) {
    reportCommandFailure("upsert_api_collection", error);
    throw coerceAppError(error);
  }
}

export async function deleteApiCollection(id: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("delete_api_collection", { input: { id } });
  } catch (error) {
    reportCommandFailure("delete_api_collection", error, id);
    throw coerceAppError(error);
  }
}

export async function listApiCollectionItems(collectionId: string): Promise<ApiCollectionItem[]> {
  if (!isTauriRuntime()) return [];
  try {
    const payload = await invoke<unknown>("list_api_collection_items", {
      input: { collectionId },
    });
    return parseApiCollectionItems(payload);
  } catch (error) {
    reportCommandFailure("list_api_collection_items", error, collectionId);
    throw coerceAppError(error);
  }
}

export async function getApiCollectionItem(id: string): Promise<ApiCollectionItem> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Not available outside Tauri runtime");
  }
  try {
    const payload = await invoke<unknown>("get_api_collection_item", { input: { id } });
    return parseApiCollectionItem(payload);
  } catch (error) {
    reportCommandFailure("get_api_collection_item", error, id);
    throw coerceAppError(error);
  }
}

export async function upsertApiCollectionItem(
  input: CollectionSaveInput,
): Promise<ApiCollectionItem> {
  if (!isTauriRuntime()) {
    return {
      id: input.id ?? crypto.randomUUID(),
      collectionId: input.collectionId,
      name: input.name,
      description: input.description ?? "",
      sortOrder: 0,
      method: input.method,
      url: input.url,
      headers: input.headers,
      body: input.body,
      bodyType: input.bodyType,
      rawLanguage: input.rawLanguage,
      formData: input.formData,
      urlEncoded: input.urlEncoded,
      formFiles: input.formFiles ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const payload = await invoke<unknown>("upsert_api_collection_item", { input });
    return parseApiCollectionItem(payload);
  } catch (error) {
    reportCommandFailure("upsert_api_collection_item", error);
    throw coerceAppError(error);
  }
}

export async function deleteApiCollectionItem(id: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("delete_api_collection_item", { input: { id } });
  } catch (error) {
    reportCommandFailure("delete_api_collection_item", error, id);
    throw coerceAppError(error);
  }
}

export async function moveApiCollectionItem(
  id: string,
  targetCollectionId: string,
  sortOrder: number,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("move_api_collection_item", {
      input: { id, targetCollectionId, sortOrder },
    });
  } catch (error) {
    reportCommandFailure("move_api_collection_item", error, id);
    throw coerceAppError(error);
  }
}

export async function moveApiCollection(
  id: string,
  targetParentId: string | null,
  sortOrder: number,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("move_api_collection", {
      input: { id, targetParentId, sortOrder },
    });
  } catch (error) {
    reportCommandFailure("move_api_collection", error, id);
    throw coerceAppError(error);
  }
}

export async function saveSessionToCollection(
  input: SessionToCollectionInput,
): Promise<ApiCollectionItem> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Not available outside Tauri runtime");
  }
  try {
    const payload = await invoke<unknown>("save_session_to_collection", { input });
    return parseApiCollectionItem(payload);
  } catch (error) {
    reportCommandFailure("save_session_to_collection", error, input.sessionId);
    throw coerceAppError(error);
  }
}

// ---------------------------------------------------------------------------
// API Environment commands
// ---------------------------------------------------------------------------

export async function batchExecuteCollectionItems(
  input: BatchExecuteInput,
): Promise<SessionDetail[]> {
  if (!isTauriRuntime()) {
    throw coerceAppError("Not available outside Tauri runtime");
  }
  try {
    const payload = await invoke<unknown[]>("batch_execute_collection_items", { input });
    return payload.map((item) => parseSessionDetail(item));
  } catch (error) {
    reportCommandFailure("batch_execute_collection_items", error);
    throw coerceAppError(error);
  }
}
