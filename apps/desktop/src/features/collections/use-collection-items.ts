import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiCollectionItem, CollectionSaveInput } from "@aiproxy/shared-types";

import {
  deleteApiCollectionItem,
  getApiCollectionItem,
  listApiCollectionItems,
  moveApiCollectionItem,
  upsertApiCollectionItem,
} from "@/services/commands";

export function useCollectionItems(collectionId: string | null) {
  return useQuery({
    queryKey: ["api-collection-items", collectionId],
    queryFn: () => (collectionId ? listApiCollectionItems(collectionId) : []),
    enabled: !!collectionId,
  });
}

export function useCollectionItem(itemId: string | null) {
  return useQuery({
    queryKey: ["api-collection-item", itemId],
    queryFn: () => (itemId ? getApiCollectionItem(itemId) : null),
    enabled: !!itemId,
  });
}

export function useUpsertCollectionItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CollectionSaveInput) => upsertApiCollectionItem(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: ["api-collection-items", result.collectionId],
      });
      queryClient.invalidateQueries({ queryKey: ["api-collection-item"] });
    },
  });
}

export function useDeleteCollectionItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; collectionId: string }) => deleteApiCollectionItem(id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["api-collection-items", variables.collectionId],
      });
    },
    // Surfaced inside the delete ConfirmDialog while it stays open on failure.
    meta: { suppressGlobalErrorNotification: true },
  });
}

export type MoveCollectionItemInput = {
  id: string;
  sourceCollectionId: string;
  targetCollectionId: string;
  sortOrder: number;
};

export function useMoveCollectionItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetCollectionId, sortOrder }: MoveCollectionItemInput) =>
      moveApiCollectionItem(id, targetCollectionId, sortOrder),
    onMutate: async (variables) => {
      const sourceKey = ["api-collection-items", variables.sourceCollectionId];
      const targetKey = ["api-collection-items", variables.targetCollectionId];
      await queryClient.cancelQueries({ queryKey: sourceKey });
      if (variables.sourceCollectionId !== variables.targetCollectionId) {
        await queryClient.cancelQueries({ queryKey: targetKey });
      }

      const previousSource = queryClient.getQueryData<ApiCollectionItem[]>(sourceKey) ?? null;
      const previousTarget =
        variables.sourceCollectionId === variables.targetCollectionId
          ? null
          : (queryClient.getQueryData<ApiCollectionItem[]>(targetKey) ?? null);

      const moved = previousSource?.find((it) => it.id === variables.id);
      if (moved) {
        if (variables.sourceCollectionId === variables.targetCollectionId) {
          queryClient.setQueryData<ApiCollectionItem[]>(
            sourceKey,
            applyOptimisticReorderItems(previousSource ?? [], variables.id, variables.sortOrder),
          );
        } else {
          queryClient.setQueryData<ApiCollectionItem[]>(
            sourceKey,
            renumberItems((previousSource ?? []).filter((it) => it.id !== variables.id)),
          );
          const movedIntoTarget: ApiCollectionItem = {
            ...moved,
            collectionId: variables.targetCollectionId,
          };
          const nextTarget = [...(previousTarget ?? [])];
          const idx = Math.max(0, Math.min(variables.sortOrder, nextTarget.length));
          nextTarget.splice(idx, 0, movedIntoTarget);
          queryClient.setQueryData<ApiCollectionItem[]>(targetKey, renumberItems(nextTarget));
        }
      }

      return { previousSource, previousTarget };
    },
    onError: (_error, variables, context) => {
      const sourceKey = ["api-collection-items", variables.sourceCollectionId];
      const targetKey = ["api-collection-items", variables.targetCollectionId];
      if (context?.previousSource) {
        queryClient.setQueryData(sourceKey, context.previousSource);
      }
      if (context?.previousTarget) {
        queryClient.setQueryData(targetKey, context.previousTarget);
      }
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["api-collection-items", variables.sourceCollectionId],
      });
      if (variables.sourceCollectionId !== variables.targetCollectionId) {
        queryClient.invalidateQueries({
          queryKey: ["api-collection-items", variables.targetCollectionId],
        });
      }
    },
  });
}

function renumberItems(items: ApiCollectionItem[]): ApiCollectionItem[] {
  return items.map((it, idx) => ({ ...it, sortOrder: idx }));
}

function applyOptimisticReorderItems(
  items: ApiCollectionItem[],
  movedId: string,
  sortOrder: number,
): ApiCollectionItem[] {
  const moved = items.find((it) => it.id === movedId);
  if (!moved) return items;
  const others = items.filter((it) => it.id !== movedId);
  const idx = Math.max(0, Math.min(sortOrder, others.length));
  others.splice(idx, 0, moved);
  return renumberItems(others);
}
