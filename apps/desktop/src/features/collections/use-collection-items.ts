import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollectionSaveInput } from "@aiproxy/shared-types";

import {
  deleteApiCollectionItem,
  getApiCollectionItem,
  listApiCollectionItems,
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
    mutationFn: ({ id }: { id: string; collectionId: string }) =>
      deleteApiCollectionItem(id),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["api-collection-items", variables.collectionId],
      });
    },
  });
}
