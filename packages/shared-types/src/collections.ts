import { coerceAppError } from "./common";
import { type HeaderEntry, isHeaderEntry } from "./sessions";

export type ApiCollection = {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ApiCollectionItem = {
  id: string;
  collectionId: string;
  name: string;
  description: string;
  sortOrder: number;
  method: string;
  url: string;
  headers: HeaderEntry[];
  body: string;
  bodyType: string;
  rawLanguage: string;
  formData: HeaderEntry[];
  urlEncoded: HeaderEntry[];
  createdAt: string;
  updatedAt: string;
};

export type CollectionSaveInput = {
  id?: string;
  collectionId: string;
  name: string;
  description?: string;
  method: string;
  url: string;
  headers: HeaderEntry[];
  body: string;
  bodyType: string;
  rawLanguage: string;
  formData: HeaderEntry[];
  urlEncoded: HeaderEntry[];
};

export type SessionToCollectionInput = {
  sessionId: string;
  collectionId: string;
  name?: string;
};

export type BatchExecuteInput = {
  itemIds: string[];
  environmentId?: string;
};

export type MoveApiCollectionInput = {
  id: string;
  targetParentId: string | null;
  sortOrder: number;
};

export type MoveApiCollectionItemInput = {
  id: string;
  targetCollectionId: string;
  sortOrder: number;
};

export type BatchExecuteProgress = {
  completedIndex: number;
  totalCount: number;
  itemId: string;
  success: boolean;
};

export function isApiCollection(value: unknown): value is ApiCollection {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ApiCollection>;
  return (
    typeof candidate.id === "string" &&
    (candidate.parentId === null || typeof candidate.parentId === "string") &&
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.sortOrder === "number" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

export function parseApiCollections(value: unknown): ApiCollection[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isApiCollection)) return value;
  throw coerceAppError(value);
}

export function isApiCollectionItem(value: unknown): value is ApiCollectionItem {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ApiCollectionItem>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.collectionId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.sortOrder === "number" &&
    typeof candidate.method === "string" &&
    typeof candidate.url === "string" &&
    Array.isArray(candidate.headers) &&
    candidate.headers.every(isHeaderEntry) &&
    typeof candidate.body === "string" &&
    typeof candidate.bodyType === "string" &&
    typeof candidate.rawLanguage === "string" &&
    Array.isArray(candidate.formData) &&
    candidate.formData.every(isHeaderEntry) &&
    Array.isArray(candidate.urlEncoded) &&
    candidate.urlEncoded.every(isHeaderEntry) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

export function parseApiCollectionItem(value: unknown): ApiCollectionItem {
  if (isApiCollectionItem(value)) return value;
  throw coerceAppError(value);
}

export function parseApiCollectionItems(value: unknown): ApiCollectionItem[] {
  if (!Array.isArray(value)) throw coerceAppError(value);
  if (value.every(isApiCollectionItem)) return value;
  throw coerceAppError(value);
}

export function isBatchExecuteProgress(value: unknown): value is BatchExecuteProgress {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BatchExecuteProgress>;
  return (
    typeof candidate.completedIndex === "number" &&
    typeof candidate.totalCount === "number" &&
    typeof candidate.itemId === "string" &&
    typeof candidate.success === "boolean"
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------
