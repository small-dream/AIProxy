import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiCollection } from "@aiproxy/shared-types";

import {
  deleteApiCollection,
  listApiCollections,
  moveApiCollection,
  upsertApiCollection,
} from "@/services/commands";

const COLLECTIONS_KEY = ["api-collections"];

export function useCollections() {
  return useQuery({
    queryKey: COLLECTIONS_KEY,
    queryFn: listApiCollections,
  });
}

export function useUpsertCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id?: string;
      parentId?: string | null;
      name: string;
      description?: string;
      sortOrder?: number;
    }) => upsertApiCollection(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY });
    },
  });
}

export function useDeleteCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiCollection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY });
      queryClient.invalidateQueries({ queryKey: ["api-collection-items"] });
    },
    // Surfaced inside the delete ConfirmDialog while it stays open on failure.
    meta: { suppressGlobalErrorNotification: true },
  });
}

export type MoveCollectionInput = {
  id: string;
  targetParentId: string | null;
  sortOrder: number;
};

export function useMoveCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetParentId, sortOrder }: MoveCollectionInput) =>
      moveApiCollection(id, targetParentId, sortOrder),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: COLLECTIONS_KEY });
      const previous = queryClient.getQueryData<ApiCollection[]>(COLLECTIONS_KEY);
      if (previous) {
        queryClient.setQueryData<ApiCollection[]>(
          COLLECTIONS_KEY,
          applyOptimisticMoveCollection(previous, variables),
        );
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(COLLECTIONS_KEY, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY });
    },
    // Callers surface the failure through the tree's move-error snackbar.
    meta: { suppressGlobalErrorNotification: true },
  });
}

export function buildCollectionTree(collections: ApiCollection[]): CollectionTreeNode[] {
  const map = new Map<string, CollectionTreeNode>();
  const roots: CollectionTreeNode[] = [];

  for (const c of collections) {
    map.set(c.id, { ...c, children: [] });
  }

  for (const c of collections) {
    const node = map.get(c.id)!;
    if (c.parentId && map.has(c.parentId)) {
      map.get(c.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export type CollectionTreeNode = ApiCollection & { children: CollectionTreeNode[] };

function applyOptimisticMoveCollection(
  collections: ApiCollection[],
  move: MoveCollectionInput,
): ApiCollection[] {
  const moved = collections.find((c) => c.id === move.id);
  if (!moved) return collections;

  const oldParentId = moved.parentId;
  const sameParent = oldParentId === move.targetParentId;

  const targetSiblings = collections
    .filter((c) => c.parentId === move.targetParentId && c.id !== move.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((c) => c.id);
  const targetIdx = Math.max(0, Math.min(move.sortOrder, targetSiblings.length));
  targetSiblings.splice(targetIdx, 0, move.id);

  const newSortOrders = new Map<string, number>();
  targetSiblings.forEach((id, i) => {
    newSortOrders.set(id, i);
  });

  if (!sameParent) {
    const oldSiblings = collections
      .filter((c) => c.parentId === oldParentId && c.id !== move.id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((c) => c.id);
    oldSiblings.forEach((id, i) => {
      newSortOrders.set(id, i);
    });
  }

  return collections
    .map((c) => {
      if (c.id === move.id) {
        return {
          ...c,
          parentId: move.targetParentId,
          sortOrder: newSortOrders.get(c.id) ?? c.sortOrder,
        };
      }
      if (newSortOrders.has(c.id)) {
        return { ...c, sortOrder: newSortOrders.get(c.id)! };
      }
      return c;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}
