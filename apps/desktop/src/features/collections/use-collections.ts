import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiCollection } from "@aiproxy/shared-types";

import {
  deleteApiCollection,
  listApiCollections,
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
